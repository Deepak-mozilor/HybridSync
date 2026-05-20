const db = require('../db');
const { upcomingWorkDays, todayKey } = require('../utils/dates');
const { getMeetingsForDate } = require('../services/googleCalendar');

const STATUS_EMOJI = { WFH: '🏠', Office: '🏢', Sick: '🤒', Leave: '🌴' };
const STATUS_LABEL = { WFH: 'Work From Home', Office: 'In Office', Sick: 'Out Sick', Leave: 'On Leave' };
const DAY_FULL    = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };

const SCORE_BAR = score => {
  const filled = Math.round(score / 2);
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled);
};

function friendlyDate(dateKey) {
  const d = new Date(dateKey + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function divider() { return { type: 'divider' }; }

function md(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function ctx(...texts) {
  return { type: 'context', elements: texts.map(t => ({ type: 'mrkdwn', text: t })) };
}

function bestCollabDay(week, schedule, highDeps, peerMap, userMeetingByDate = {}) {
  if (!highDeps.length) return null;

  const dayScores = [];
  for (const { dateKey, day } of week) {
    const userStatus = schedule.find(s => s.dateKey === dateKey)?.status;
    if (!userStatus || userStatus === 'Sick' || userStatus === 'Leave') continue;

    let weightedScore = 0;
    const colocated = [];

    for (const dep of highDeps) {
      const peer = peerMap.get(dep.peerId);
      if (!peer) continue;
      if (peer.statusByDate[dateKey] === userStatus) {
        weightedScore += dep.score;
        colocated.push(peer.user.displayName);
      }
    }

    // Penalise days with heavy meeting load — harder to collaborate effectively
    const load = userMeetingByDate[dateKey];
    if (load?.label === 'Heavy')    weightedScore -= 5;
    else if (load?.label === 'Moderate') weightedScore -= 2;

    dayScores.push({ day, dateKey, userStatus, weightedScore, colocated, matchCount: colocated.length, meetingLoad: load });
  }

  if (!dayScores.length) return null;
  return dayScores.sort((a, b) => b.weightedScore - a.weightedScore)[0];
}

function buildConnectOAuthUrl(userId) {
  const clientId   = process.env.SLACK_CLIENT_ID;
  const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI || 'http://localhost:3001/api/oauth/callback';
  if (!clientId) return null;
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('user_scope', 'users.profile:write');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', userId);
  return url.toString();
}

async function buildHomeView(userId) {
  const user       = await db.ensureUser(userId);
  const team       = await db.getTeam(user.teamId);
  const anchorDays = team?.anchorDays || [];
  const week       = upcomingWorkDays(5);
  const today      = todayKey();
  const schedule   = await db.getScheduleForDates(userId, week.map(w => w.dateKey));
  const todayEntry  = schedule.find(s => s.dateKey === today);
  const todayStatus = todayEntry?.status || 'Unknown';
  const todayEmoji  = STATUS_EMOJI[todayStatus] || '❓';

  const officeDays = schedule.filter(s => s.status === 'Office').length;
  const wfhDays    = schedule.filter(s => s.status === 'WFH').length;

  const isAnchorToday = anchorDays.includes(todayEntry?.day);
  const roleLabel     = user.role === 'product_manager' ? ' _(PM)_' : user.role === 'engineer' ? ' _(Eng)_' : '';

  // --- Core collaborators ---
  const deps     = await db.getDependencyGraph(userId);
  const highDeps = deps.filter(d => d.score >= 7).sort((a, b) => b.score - a.score);

  // --- Batched peer fetch — single parallel round trip for all peers ---
  const weekDateKeys = week.map(w => w.dateKey);
  const peerEntries = await Promise.all(highDeps.map(async dep => {
    const [peerUser, peerSchedule] = await Promise.all([
      db.getUser(dep.peerId),
      db.getScheduleForDates(dep.peerId, weekDateKeys),
    ]);
    if (!peerUser) return null;
    const statusByDate = Object.fromEntries(peerSchedule.map(s => [s.dateKey, s.status]));
    return [dep.peerId, { user: peerUser, statusByDate }];
  }));
  const peerMap = new Map(peerEntries.filter(Boolean));

  // --- Slack status sync connection status ---
  const userToken     = await db.getUserToken(userId);
  const isConnected   = !!userToken;
  const oauthUrl      = buildConnectOAuthUrl(userId);

  // --- Google Calendar ---
  const googleTokens    = await db.getGoogleTokens(userId);
  const googleConnected = !!googleTokens;
  const googleAuthUrl = process.env.GOOGLE_CLIENT_ID
    ? `${process.env.SLACK_OAUTH_REDIRECT_URI?.replace('/api/oauth/callback', '') || 'http://localhost:3001'}/api/google/auth?state=${userId}`
    : null;

  // Fetch meeting load for all week days in parallel (today + rest of week)
  const userMeetingByDate = {};
  if (googleConnected) {
    const loads = await Promise.all(
      weekDateKeys.map(async dateKey => {
        const load = await getMeetingsForDate(userId, dateKey).catch(() => null);
        return [dateKey, load];
      })
    );
    loads.forEach(([dateKey, load]) => { if (load) userMeetingByDate[dateKey] = load; });
  }
  const meetingLoad = userMeetingByDate[today] || null;

  // --- Best collaboration day — factors in meeting load ---
  const best = bestCollabDay(week, schedule, highDeps, peerMap, userMeetingByDate);

  // --- Today block ---
  const todayBlock = {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `📆 *Date*\n${friendlyDate(today)}` },
      { type: 'mrkdwn', text: `${todayEmoji} *Status*\n${STATUS_LABEL[todayStatus] || todayStatus}${isAnchorToday ? '  •  📌 Anchor' : ''}` },
      { type: 'mrkdwn', text: `🏷️ *Team*\n${team?.name || 'Unassigned'}${roleLabel}` },
      { type: 'mrkdwn', text: `📊 *This Week*\n${officeDays}d Office  ·  ${wfhDays}d WFH` },
      ...(meetingLoad ? [{ type: 'mrkdwn', text: `${meetingLoad.emoji} *Meetings Today*\n${meetingLoad.count} meeting${meetingLoad.count !== 1 ? 's' : ''}  ·  ${meetingLoad.totalMinutes}min  ·  ${meetingLoad.label}` }] : []),
    ],
  };

  // --- Week schedule ---
  const weekLines = schedule.map(s => {
    const emoji      = STATUS_EMOJI[s.status] || '❓';
    const isToday    = s.dateKey === today;
    const isAnchor   = anchorDays.includes(s.day);
    const todayMark  = isToday  ? '  ◀ *today*' : '';
    const anchorMark = isAnchor ? '  📌' : '';
    const dayLabel   = isToday  ? `*${s.day}*` : s.day;
    const stLabel    = isToday  ? `*${s.status}*` : s.status;
    return `${dayLabel}   ${emoji} ${stLabel}${anchorMark}${todayMark}`;
  });

  const scheduleBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text: `*📅 This Week*\n${weekLines.join('\n')}` },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: '✏️ Edit Schedule', emoji: true },
      style: 'primary',
      value: 'override_click',
      action_id: 'button_override',
    },
  };

  // --- WFH suggestion — only when most meetings are online/unknown (can be attended remotely) ---
  const mostlyOnline = meetingLoad
    ? (meetingLoad.onlineCount + meetingLoad.unknownCount) > meetingLoad.offlineCount
    : false;
  const suggestWFH = meetingLoad?.label === 'Heavy' && todayStatus === 'Office' && mostlyOnline;

  // --- Best collab day block ---
  let bestDayBlocks = [];
  if (best && best.matchCount > 0) {
    const statusEmoji = STATUS_EMOJI[best.userStatus] || '📅';
    const names = best.colocated.join(', ');
    const meetingNote = best.meetingLoad
      ? `  ·  ${best.meetingLoad.emoji} ${best.meetingLoad.label} meeting day`
      : '';
    bestDayBlocks = [
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `🗓️ *Day*\n${DAY_FULL[best.day] || best.day}` },
          { type: 'mrkdwn', text: `${statusEmoji} *Everyone's Status*\n${best.userStatus}` },
        ],
      },
      ctx(`👥 Co-located with: *${names}*  ·  combined score *${best.weightedScore}*${meetingNote}`),
    ];
  } else {
    bestDayBlocks = [md('_No overlap found this week — schedules are out of sync._')];
  }

  // --- Collaborator alert blocks (in-memory, no DB calls) ---
  const alertBlocks = [];
  for (const dep of highDeps) {
    const peer = peerMap.get(dep.peerId);
    if (!peer) continue;
    const peerStatus = peer.statusByDate[today];
    const peerEmoji  = STATUS_EMOJI[peerStatus] || '❓';
    const match      = peerStatus === todayStatus;
    const matchNote  = match
      ? '✅ Same location today'
      : `⚠️ You're ${todayStatus}, they're ${peerStatus || 'unknown'}`;

    alertBlocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `👤 *${peer.user.displayName}*\n${peerEmoji} ${STATUS_LABEL[peerStatus] || peerStatus || 'Unknown'}` },
        { type: 'mrkdwn', text: `📈 *Score:* ${SCORE_BAR(dep.score)} ${dep.score}/10\n${matchNote}` },
      ],
    });
  }

  // --- Assemble ---
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*HybridSync*  ·  My Schedule` },
    },
    ctx(`👋 Hey <@${userId}>! Here's your hybrid work snapshot for the week.`),
    divider(),

    md('*📍 Today at a Glance*'),
    todayBlock,
    ...(suggestWFH ? [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `💡 *Suggestion:* You have *${meetingLoad.count} meetings* today (${meetingLoad.onlineCount} online · ${meetingLoad.offlineCount} offline · ${meetingLoad.unknownCount} unknown). Most can be attended remotely — consider switching to *WFH 🏠*.`,
        },
      },
    ] : []),
    divider(),

    md('*⭐ Best Collaboration Day This Week*'),
    ...bestDayBlocks,
    divider(),

    scheduleBlock,
    divider(),

    md('*⚡ Core Collaborators*'),
    ...(alertBlocks.length ? alertBlocks : [md('_No high-priority collaborators found yet._')]),
    {
      type: 'actions',
      elements: [
        {
          type:      'button',
          text:      { type: 'plain_text', text: '👥 Manage Dependencies', emoji: true },
          action_id: 'button_manage_deps',
          value:     'manage_deps_click',
        },
      ],
    },
    divider(),

    ctx('💬 Say `wfh`, `in office`, or `sick` in any channel to update your status instantly.'),
    divider(),

    md('*📅 Google Calendar*'),
    googleConnected
      ? ctx('✅ *Connected* — your meeting load is visible to HybridSync and used when coordinating schedules.')
      : {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: googleAuthUrl
              ? '📆 *Not connected* — link Google Calendar so HybridSync can factor your meeting load into schedule coordination.'
              : '_Google Calendar is not configured. Ask your admin to set `GOOGLE_CLIENT_ID`._',
          },
          ...(googleAuthUrl ? {
            accessory: {
              type:      'button',
              text:      { type: 'plain_text', text: '📅 Connect Google Calendar', emoji: true },
              style:     'primary',
              url:       googleAuthUrl,
              action_id: 'connect_google_calendar',
            },
          } : {}),
        },
    divider(),

    md('*🔗 Slack Status Sync*'),
    isConnected
      ? ctx('✅ *Connected* — your Slack profile status updates automatically when your HybridSync status changes.')
      : {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: oauthUrl
              ? '🔌 *Not connected* — link your account so HybridSync can update your Slack status emoji automatically.'
              : '_Slack status sync is not configured. Ask your admin to set `SLACK_CLIENT_ID`._',
          },
          ...(oauthUrl ? {
            accessory: {
              type:      'button',
              text:      { type: 'plain_text', text: '🔗 Connect Slack Status', emoji: true },
              style:     'primary',
              url:       oauthUrl,
              action_id: 'connect_slack_status',
            },
          } : {}),
        },
  ];

  return { type: 'home', blocks };
}

async function publishHome(client, userId) {
  const view = await buildHomeView(userId);
  await client.views.publish({ user_id: userId, view });
}

module.exports = { buildHomeView, publishHome };
