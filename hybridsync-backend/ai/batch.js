// Scheduled AI batch jobs.
// Weekly Map (Sun 2:00 AM) — Recalculates dependency graph from 30-day Slack interactions.
// Works with Anthropic or Groq via the provider abstraction.

const cron = require('node-cron');
const { WebClient } = require('@slack/web-api');
const db = require('../db');
const { runAgentLoop, complete, getProvider } = require('./provider');
const { getSharedMeetingCount, renewChannels } = require('../services/googleCalendar');
const { syncAllUsersForToday } = require('../services/slackStatus');

// Builds a per-workspace WebClient list, one per installed workspace.
async function listWorkspaceClients() {
  const workspaces = await db.getAllWorkspaces();
  return workspaces.map(w => ({ workspaceId: w.id, client: new WebClient(w.bot_token) }));
}

// ---------------------------------------------------------------------------
// Slack interaction fetcher — replaces the hardcoded simulation.
// Reads conversations.history + conversations.replies for all channels the
// bot is a member of, spanning the last 30 days.
//
// Interaction signals:
//   messages  — sender @mentions another user in their message
//   replies   — user replies in a thread started by someone else
//   reactions — user reacts to someone else's message
//
// ---------------------------------------------------------------------------

async function fetchSlackInteractions(slackClient) {
  const { user_id: botId } = await slackClient.auth.test();

  // Collect all public channels the bot is a member of.
  const channelList = await slackClient.conversations.list({
    types: 'public_channel',
    exclude_archived: true,
    limit: 1000,
  });
  const channels = (channelList.channels || []).filter(c => c.is_member);

  const oldest = String(Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000));

  // Directional accumulator: pairs[userA][userB] = counts where userA initiated the
  // interaction TARGETING userB. We track both directions independently so the AI
  // can score how much A depends on B differently from how much B depends on A.
  // Semantics chosen:
  //   - A @mentions B in a message  → A→B (A is reaching out to B)
  //   - A reacts to B's message     → A→B (A is acknowledging B)
  //   - A replies in B's thread     → A→B (A is engaging with B's topic)
  const directional = {};
  function add(initiator, target, field) {
    if (!initiator || !target || initiator === target) return;
    if (!directional[initiator]) directional[initiator] = {};
    if (!directional[initiator][target]) {
      directional[initiator][target] = { messages: 0, replies: 0, reactions: 0 };
    }
    directional[initiator][target][field]++;
  }

  function realSender(msg) {
    return msg.user !== botId ? msg.user : null;
  }

  const mentionRe = /<@([A-Z0-9_]+)>/g;

  for (const ch of channels) {
    let cursor;
    do {
      const hist = await slackClient.conversations.history({
        channel: ch.id,
        oldest,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });

      for (const msg of hist.messages || []) {
        const sender = realSender(msg);
        if (!sender) continue;

        // sender → each mentioned user
        for (const [, mentioned] of (msg.text || '').matchAll(mentionRe)) {
          add(sender, mentioned, 'messages');
        }

        // reactor → sender (reactor acknowledges sender's message)
        for (const reaction of msg.reactions || []) {
          for (const reactor of reaction.users || []) {
            add(reactor, sender, 'reactions');
          }
        }

        // replier → thread author (replier engages with sender's topic)
        if ((msg.reply_count || 0) > 0) {
          const threadRes = await slackClient.conversations.replies({
            channel: ch.id,
            ts: msg.ts,
          });
          for (const reply of (threadRes.messages || []).slice(1)) { // skip parent
            const replier = realSender(reply);
            if (!replier) continue;
            add(replier, sender, 'replies');

            // @mentions inside the reply → replier → each mentioned
            for (const [, mentioned] of (reply.text || '').matchAll(mentionRe)) {
              add(replier, mentioned, 'messages');
            }
          }
        }
      }

      cursor = hist.response_metadata?.next_cursor;
    } while (cursor);
  }

  // Flatten into {userA, userB, messages, replies, reactions} rows — one per direction.
  const result = [];
  for (const [a, peers] of Object.entries(directional)) {
    for (const [b, counts] of Object.entries(peers)) {
      result.push({ userA: a, userB: b, ...counts });
    }
  }
  console.log(`[fetchSlackInteractions] ${result.length} directional rows across ${channels.length} channels.`);
  return result;
}

// ---------------------------------------------------------------------------
// Weekly Mapping — 2:00 AM every Sunday
// ---------------------------------------------------------------------------

async function runWeeklyMapping(slackClient, workspaceId) {
  if (!getProvider()) { console.log('[WeeklyMapping] No API key — skipped.'); return; }
  if (!workspaceId) throw new Error('runWeeklyMapping: workspaceId is required');

  // Use real Slack interactions when a client is provided; fall back to the
  // simulated feed so the function still works standalone in tests.
  const rawInteractions = slackClient
    ? await fetchSlackInteractions(slackClient)
    : await getSimulatedInteractions();

  // Slack channel history can include people who haven't been added to
  // HybridSync yet (messaged in a channel but never opened App Home). Drop
  // any interaction involving a user not in this workspace's DB before
  // sending to the AI — otherwise we'd compute scores for ghosts.
  const knownUserIds = new Set((await db.getAllUsers(workspaceId)).map(u => u.id));
  const interactions = rawInteractions.filter(
    i => knownUserIds.has(i.userA) && knownUserIds.has(i.userB),
  );
  const dropped = rawInteractions.length - interactions.length;
  if (dropped > 0) {
    console.log(`[WeeklyMapping] Skipped ${dropped} interaction row(s) involving users not in workspace ${workspaceId}.`);
  }

  if (interactions.length === 0) {
    console.log('[WeeklyMapping] No interaction data — skipped.');
    return;
  }

  // Enrich each directional row with shared Google Calendar meeting count
  // (symmetric: same value for both directions of the same pair).
  const enriched = await Promise.all(interactions.map(async i => {
    const sharedMeetings = await getSharedMeetingCount(i.userA, i.userB, 30).catch(() => 0);
    return { ...i, shared_meetings: sharedMeetings };
  }));

  // Expand to guarantee both directions per pair. Real Slack data often has
  // one-way rows (e.g., A reacted to B's messages but B never reacted to A's).
  // Without the reverse row the AI has nothing to score B->A and /api/graph
  // mirrors A->B's score, making the edge look symmetric. Insert a zero-row
  // for the missing direction so the AI explicitly scores it as low.
  const seen = new Set(enriched.map(i => `${i.userA}->${i.userB}`));
  const sharedFor = {};
  enriched.forEach(i => {
    sharedFor[[i.userA, i.userB].sort().join(':')] = i.shared_meetings;
  });
  const fullRows = [...enriched];
  for (const i of enriched) {
    const reverseKey = `${i.userB}->${i.userA}`;
    if (seen.has(reverseKey)) continue;
    seen.add(reverseKey);
    fullRows.push({
      userA: i.userB,
      userB: i.userA,
      messages: 0, replies: 0, reactions: 0,
      shared_meetings: sharedFor[[i.userA, i.userB].sort().join(':')] || 0,
    });
  }

  const prompt = `Analyze these 30-day DIRECTIONAL interaction counts and compute a Dependency Score (1-10) per row.
Each row represents how much userA depends on userB based on userA's outgoing actions to userB:
  - msgs:      @mentions of userB in messages sent by userA
  - replies:   replies userA made in userB's threads
  - reactions: emoji reactions userA placed on userB's messages
  - shared_meetings: recurring calendar meetings with both as attendees (symmetric for the pair)

Scoring: 9-10 = critical daily collaborator, 7-8 = high, 5-6 = moderate, 3-4 = low, 1-2 = minimal.
Weight shared_meetings heavily — structured collaboration is a strong dependency signal.
Higher outgoing actions from A to B → A depends more on B.

Data (one row per direction — zero-count rows are real and mean low dependency in that direction):
${fullRows.map(i => `- ${i.userA} -> ${i.userB}: ${i.messages} msgs, ${i.replies} replies, ${i.reactions} reactions, ${i.shared_meetings} shared meetings`).join('\n')}

Output ONLY a JSON array (no prose), one entry per input row:
[{"userId":"A","peerId":"B","score":N}, ...]
Use userId = the row's first user (the dependent) and peerId = the row's second user.`;

  // Rough token estimate: ~4 chars per token is the usual heuristic.
  const promptChars  = prompt.length;
  const promptTokensEst = Math.round(promptChars / 4);
  console.log(
    `[WeeklyMapping] Starting dependency graph rebuild — ` +
    `workspace=${workspaceId} rows=${fullRows.length} ` +
    `promptChars=${promptChars} estInputTokens=~${promptTokensEst}`
  );
  const startedAt = Date.now();
  const raw = await complete(
    'You are HybridSync\'s dependency graph calculator. Output only valid JSON.',
    prompt,
    'WeeklyMapping'
  );
  const elapsedMs = Date.now() - startedAt;
  console.log(`[WeeklyMapping] AI call complete in ${elapsedMs}ms (rawLen=${raw?.length || 0})`);
  if (!raw) return;

  try {
    const clean  = raw.replace(/```(?:json)?/g, '').trim();
    const parsed = JSON.parse(clean);
    const edges  = Array.isArray(parsed) ? parsed : (parsed.dependencies || parsed.edges || []);

    // Save manual edges before wiping — they will be restored after.
    const manualEdges = await db.getAllManualDependencies(workspaceId);

    // Wipe existing edges for THIS workspace so stale scores don't persist.
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await supabase.from('dependencies').delete().eq('workspace_id', workspaceId);

    // Write AI-calculated scores.
    const byUser = {};
    for (const e of edges) {
      if (!byUser[e.userId]) byUser[e.userId] = [];
      byUser[e.userId].push({ peerId: e.peerId, score: e.score, isManual: false });
    }
    for (const [userId, peerEdges] of Object.entries(byUser)) {
      await db._updateDependencies(userId, peerEdges);
    }

    // Re-apply manual edges on top — manual always wins.
    if (manualEdges.length > 0) {
      const manualByUser = {};
      for (const e of manualEdges) {
        if (!manualByUser[e.user_id]) manualByUser[e.user_id] = [];
        manualByUser[e.user_id].push({ peerId: e.peer_id, score: e.score, isManual: true });
      }
      for (const [userId, peerEdges] of Object.entries(manualByUser)) {
        const existing = await db.getDependencyGraph(userId);
        const merged = existing.filter(e => !peerEdges.find(m => m.peerId === e.peerId));
        merged.push(...peerEdges);
        await db._updateDependencies(userId, merged);
      }
      console.log(`[WeeklyMapping] Restored ${manualEdges.length} manual edge(s).`);
    }

    console.log(`[WeeklyMapping] Rebuilt: ${edges.length} AI edges across ${Object.keys(byUser).length} users.`);
  } catch (err) {
    console.error('[WeeklyMapping] Failed to parse output:', err.message, '\nRaw:', raw?.slice(0, 200));
  }
}

// Fallback used when no slackClient is available (unit tests, manual triggers).
// Empty by default — the caller short-circuits on no interactions.
async function getSimulatedInteractions() {
  return [];
}

// ---------------------------------------------------------------------------
// Register cron jobs — slackClient passed in from app.js
// ---------------------------------------------------------------------------

// Reports a cron-job failure to both stdout and Sentry.
function reportCronError(job, e) {
  console.error(`[${job}] Error:`, e.message);
  const Sentry = require('../instrument');
  Sentry.captureException(e, { tags: { cron_job: job } });
}

function start() {
  cron.schedule('0 2 * * 0', async () => {
    const targets = await listWorkspaceClients();
    if (!targets.length) return console.warn('[WeeklyMapping] No workspace installed — skipping');
    for (const { workspaceId, client } of targets) {
      await runWeeklyMapping(client, workspaceId)
        .catch(e => reportCronError(`WeeklyMapping/${workspaceId}`, e));
    }
  });
  // Renew Google Calendar webhook channels daily before they expire (max 7 days)
  cron.schedule('0 3 * * *', () => renewChannels().catch(e => reportCronError('GoogleChannelRenewal', e)));
  // Daily Slack-status sweep — Mon-Fri 8 AM IST (= 02:30 UTC)
  cron.schedule('30 2 * * 1-5', () => syncAllUsersForToday().catch(e => reportCronError('DailyStatusSync', e)));
  console.log('[Batch] Scheduled: weekly mapping Sun 2 AM, Google channel renewal daily 3 AM, daily status sync Mon-Fri 8 AM IST.');
}

module.exports = { start, runWeeklyMapping, fetchSlackInteractions, syncAllUsersForToday };
