// One-shot script: posts fake conversation threads to #hybridsync-test.
// Each message carries Slack metadata encoding the "real" sender so that
// fetchSlackInteractions() can reconstruct interaction pairs accurately.
//
// Required Slack scopes (add in your app manifest):
//   chat:write            — already required for the bot
//   chat:write.customize  — allows username + icon_emoji overrides
//   channels:manage       — to create the channel if it doesn't exist
//   channels:join         — to join the channel
//
// Run once:  node scripts/seedConversations.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { WebClient } = require('@slack/web-api');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const CHANNEL_NAME = 'hybridsync-test';

// Visual personas — username/icon overrides make messages look distinct in Slack.
// The real userId is stored in message metadata, not derived from these.
const PERSONAS = {
  'U0B3PJ1QP1B': { username: 'Deepak · PM',     icon_emoji: ':briefcase:' },
  'U0B3WJ5RQ3W': { username: 'Jithu · Eng',     icon_emoji: ':computer:' },
  'U_RIYA':       { username: 'Riya · Design',   icon_emoji: ':art:' },
  'U_KARAN':      { username: 'Karan · QA',      icon_emoji: ':mag:' },
};

// Interaction targets that drive the AI scoring:
//   Deepak  <-> Jithu  : high-frequency  → expected score ~9
//   Deepak  <-> Riya   : moderate-high   → expected score ~7
//   Jithu   <-> Riya   : moderate        → expected score ~6
//   Deepak  <-> Karan  : low             → expected score ~4
//   Jithu   <-> Karan  : minimal         → expected score ~2
const THREADS = [
  // ── Deepak <-> Jithu (5 threads, 14 replies) ──────────────────────────────
  {
    from: 'U0B3PJ1QP1B',
    text: `<@U0B3WJ5RQ3W> PR #42 needs your review — it's blocking the sprint.`,
    replies: [
      { from: 'U0B3WJ5RQ3W', text: `On it <@U0B3PJ1QP1B>, looking now.` },
      { from: 'U0B3PJ1QP1B', text: `Also check error handling around line 88 <@U0B3WJ5RQ3W>.` },
      { from: 'U0B3WJ5RQ3W', text: `<@U0B3PJ1QP1B> approved with minor comments. Good to merge.` },
    ],
  },
  {
    from: 'U0B3WJ5RQ3W',
    text: `<@U0B3PJ1QP1B> the API spec needs sign-off before we start implementation.`,
    replies: [
      { from: 'U0B3PJ1QP1B', text: `Looking now <@U0B3WJ5RQ3W>.` },
      { from: 'U0B3WJ5RQ3W', text: `Let me know if you need the Figma link too <@U0B3PJ1QP1B>.` },
      { from: 'U0B3PJ1QP1B', text: `<@U0B3WJ5RQ3W> approved! Add pagination for the list endpoint.` },
    ],
  },
  {
    from: 'U0B3PJ1QP1B',
    text: `Pairing with <@U0B3WJ5RQ3W> this afternoon on the auth module. Should unblock the team.`,
    replies: [
      { from: 'U0B3WJ5RQ3W', text: `3pm works for me <@U0B3PJ1QP1B>.` },
      { from: 'U0B3PJ1QP1B', text: `See you then <@U0B3WJ5RQ3W> 👍` },
    ],
  },
  {
    from: 'U0B3WJ5RQ3W',
    text: `<@U0B3PJ1QP1B> just pushed the auth fix. All tests green.`,
    replies: [
      { from: 'U0B3PJ1QP1B', text: `Merging now <@U0B3WJ5RQ3W>. Sprint closed 🎉` },
    ],
  },
  {
    from: 'U0B3PJ1QP1B',
    text: `<@U0B3WJ5RQ3W> can you sanity-check the deployment config before EOD?`,
    replies: [
      { from: 'U0B3WJ5RQ3W', text: `On it <@U0B3PJ1QP1B>.` },
      { from: 'U0B3WJ5RQ3W', text: `Config looks correct <@U0B3PJ1QP1B>. Safe to deploy.` },
      { from: 'U0B3PJ1QP1B', text: `Perfect <@U0B3WJ5RQ3W>, deploying now.` },
    ],
  },

  // ── Deepak <-> Riya (3 threads, 7 replies) ────────────────────────────────
  {
    from: 'U_RIYA',
    text: `<@U0B3PJ1QP1B> — final dashboard mockups are ready for your approval.`,
    replies: [
      { from: 'U0B3PJ1QP1B', text: `Love it <@U_RIYA>. One ask: make the header a bit taller.` },
      { from: 'U_RIYA',       text: `Done <@U0B3PJ1QP1B>. Uploaded v3.` },
      { from: 'U0B3PJ1QP1B', text: `Perfect <@U_RIYA>, approved! 🚀` },
    ],
  },
  {
    from: 'U0B3PJ1QP1B',
    text: `<@U_RIYA> need a new onboarding flow design. Brief is in Notion.`,
    replies: [
      { from: 'U_RIYA',       text: `Got it <@U0B3PJ1QP1B>, will have a draft by Wednesday.` },
      { from: 'U0B3PJ1QP1B', text: `Thanks <@U_RIYA>!` },
    ],
  },
  {
    from: 'U_RIYA',
    text: `Design review with <@U0B3PJ1QP1B> — Thursday 11am?`,
    replies: [
      { from: 'U0B3PJ1QP1B', text: `Works for me <@U_RIYA> 👍` },
    ],
  },

  // ── Jithu <-> Riya (2 threads, 4 replies) ─────────────────────────────────
  {
    from: 'U0B3WJ5RQ3W',
    text: `<@U_RIYA> can you export the icon set as SVGs? Need them for the component library.`,
    replies: [
      { from: 'U_RIYA',       text: `On it <@U0B3WJ5RQ3W>, will drop them in the shared folder.` },
      { from: 'U0B3WJ5RQ3W', text: `Thanks <@U_RIYA>!` },
    ],
  },
  {
    from: 'U_RIYA',
    text: `<@U0B3WJ5RQ3W> the button colors don't match the design system tokens. Can you check?`,
    replies: [
      { from: 'U0B3WJ5RQ3W', text: `You're right <@U_RIYA>, fixing now.` },
      { from: 'U_RIYA',       text: `Looks perfect now <@U0B3WJ5RQ3W>, thanks!` },
    ],
  },

  // ── Deepak <-> Karan (2 threads, 3 replies) ───────────────────────────────
  {
    from: 'U_KARAN',
    text: `<@U0B3PJ1QP1B> found a bug in the CSV export. Ticket filed.`,
    replies: [
      { from: 'U0B3PJ1QP1B', text: `Thanks <@U_KARAN>, assigning to next sprint.` },
    ],
  },
  {
    from: 'U0B3PJ1QP1B',
    text: `<@U_KARAN> can you run regression tests on the login flow before Thursday's release?`,
    replies: [
      { from: 'U_KARAN',      text: `On it <@U0B3PJ1QP1B>.` },
      { from: 'U_KARAN',      text: `<@U0B3PJ1QP1B> all passed. Green.` },
    ],
  },

  // ── Jithu <-> Karan (1 thread, 1 reply) ───────────────────────────────────
  {
    from: 'U_KARAN',
    text: `<@U0B3WJ5RQ3W> test env is down again — can you check?`,
    replies: [
      { from: 'U0B3WJ5RQ3W', text: `Rebooting it now <@U_KARAN>.` },
    ],
  },
];

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function post(channelId, { from, text, thread_ts }) {
  const persona = PERSONAS[from] || { username: from, icon_emoji: ':ghost:' };
  const result = await slack.chat.postMessage({
    channel: channelId,
    text,
    username:   persona.username,
    icon_emoji: persona.icon_emoji,
    ...(thread_ts ? { thread_ts } : {}),
    // Metadata encodes the real sender — read back by fetchSlackInteractions().
    metadata: {
      event_type:    'sim_sender',
      event_payload: { user_id: from },
    },
  });
  return result.ts;
}

async function findOrCreateChannel() {
  const { channels } = await slack.conversations.list({
    types: 'public_channel',
    exclude_archived: true,
    limit: 1000,
  });
  const existing = channels.find(c => c.name === CHANNEL_NAME);
  if (existing) {
    console.log(`Using existing #${CHANNEL_NAME} (${existing.id})`);
    return existing.id;
  }
  const { channel } = await slack.conversations.create({ name: CHANNEL_NAME, is_private: false });
  console.log(`Created #${CHANNEL_NAME} (${channel.id})`);
  return channel.id;
}

async function run() {
  const channelId = await findOrCreateChannel();

  // Join the channel so the bot can post into it
  try {
    await slack.conversations.join({ channel: channelId });
  } catch (_) {
    // already a member — fine
  }

  let totalMessages = 0;
  console.log(`\nPosting ${THREADS.length} threads...\n`);

  for (const thread of THREADS) {
    const parentTs = await post(channelId, { from: thread.from, text: thread.text });
    totalMessages++;
    await sleep(400);

    for (const reply of thread.replies || []) {
      await post(channelId, { from: reply.from, text: reply.text, thread_ts: parentTs });
      totalMessages++;
      await sleep(300);
    }

    const preview = thread.text.replace(/<@[^>]+>/g, '@user').slice(0, 60);
    console.log(`  ✓ [${thread.from}] "${preview}..."`);
  }

  console.log(`\nDone — ${totalMessages} messages across ${THREADS.length} threads in #${CHANNEL_NAME}.`);
  console.log(`Run the weekly mapping to compute scores:\n  node -e "require('./ai/batch').runWeeklyMapping(require('./app').client)"`);
}

run().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
