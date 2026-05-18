// Scheduled AI batch jobs.
// Daily Sweep  (7:00 AM)     — Scans last 24h messages for ambiguous scheduling intent.
// Weekly Map   (Sun 2:00 AM) — Recalculates dependency graph from 30-day Slack interactions.
// Works with Anthropic or Groq via the provider abstraction.

const cron = require('node-cron');
const db = require('../db');
const { todayKey } = require('../utils/dates');
const { runAgentLoop, complete, getProvider } = require('./provider');

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
// Seed messages posted by scripts/seedConversations.js carry metadata
// { event_type: 'sim_sender', event_payload: { user_id } } so their "real"
// sender is recovered even though the Slack user field is the bot's ID.
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

  // Symmetric pair accumulator
  const pairs = {};
  function add(a, b, field) {
    if (!a || !b || a === b) return;
    const key = [a, b].sort().join(':');
    if (!pairs[key]) pairs[key] = { userA: key.split(':')[0], userB: key.split(':')[1], messages: 0, replies: 0, reactions: 0 };
    pairs[key][field]++;
  }

  // Extract real sender: prefer metadata (seeded messages), fall back to message.user.
  // Skip plain bot messages that carry no metadata (system posts, etc.).
  function realSender(msg) {
    const sim = msg.metadata?.event_payload?.user_id;
    if (sim) return sim;
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
        include_all_metadata: true,
        ...(cursor ? { cursor } : {}),
      });

      for (const msg of hist.messages || []) {
        const sender = realSender(msg);
        if (!sender) continue;

        // @mention interactions
        for (const [, mentioned] of (msg.text || '').matchAll(mentionRe)) {
          add(sender, mentioned, 'messages');
        }

        // Reaction interactions — reactions array is included in conversations.history
        for (const reaction of msg.reactions || []) {
          for (const reactor of reaction.users || []) {
            add(sender, reactor, 'reactions');
          }
        }

        // Thread reply interactions
        if ((msg.reply_count || 0) > 0) {
          const threadRes = await slackClient.conversations.replies({
            channel: ch.id,
            ts: msg.ts,
            include_all_metadata: true,
          });
          for (const reply of (threadRes.messages || []).slice(1)) { // slice off parent
            const replier = realSender(reply);
            if (!replier) continue;

            // Replier <-> thread author
            add(sender, replier, 'replies');

            // @mentions inside the reply
            for (const [, mentioned] of (reply.text || '').matchAll(mentionRe)) {
              add(replier, mentioned, 'messages');
            }
          }
        }
      }

      cursor = hist.response_metadata?.next_cursor;
    } while (cursor);
  }

  const result = Object.values(pairs);
  console.log(`[fetchSlackInteractions] ${result.length} unique pairs across ${channels.length} channels.`);
  return result;
}

// ---------------------------------------------------------------------------
// Daily Sweep — 7:00 AM every day
// ---------------------------------------------------------------------------

const SWEEP_SYSTEM = `You are HybridSync's daily sweep analyzer.
Scan the messages and identify users signaling WFH, Office, or Sick intent with >= 80% confidence.
Call update_schedule_db only for clear signals. Skip ambiguous ones.`;

const SWEEP_TOOLS = [
  {
    name: 'update_schedule_db',
    description: 'Persists a user status when their intent is clear.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        date:   { type: 'string' },
        status: { type: 'string', enum: ['WFH', 'Office', 'Sick', 'Leave'] },
        reason: { type: 'string', description: 'One-line explanation of the detected signal.' },
      },
      required: ['userId', 'date', 'status', 'reason'],
    },
  },
];

// Simulated feed — swap getLast24hMessages() with a real conversations.history
// call (filtered to the last 24h) for production.
async function getLast24hMessages() {
  return [
    { userId: 'U0B3PJ1QP1B', text: 'Not feeling great today, going to WFH.' },
    { userId: 'U0B3WJ5RQ3W', text: 'Heading to the office, see everyone there!' },
    { userId: 'U_RIYA',      text: 'Doctor appointment in the morning, will be late today.' },
  ];
}

async function runDailySweep() {
  if (!getProvider()) { console.log('[DailySweep] No API key — skipped.'); return; }

  const today    = todayKey();
  const messages = await getLast24hMessages();
  const userMessage = `Today is ${today}. Analyze these messages and update any clear WFH/Office/Sick signals:\n${messages.map(m => `- ${m.userId}: "${m.text}"`).join('\n')}`;

  console.log('[DailySweep] Starting...');
  await runAgentLoop(SWEEP_SYSTEM, userMessage, SWEEP_TOOLS, async (toolName, input) => {
    if (toolName === 'update_schedule_db') {
      console.log(`[DailySweep] ${input.userId} → ${input.status} (${input.reason})`);
      await db.ensureUser(input.userId);
      await db.setStatus(input.userId, input.date, input.status);
      return JSON.stringify({ updated: true });
    }
    return JSON.stringify({ error: 'unknown tool' });
  });
  console.log('[DailySweep] Complete.');
}

// ---------------------------------------------------------------------------
// Weekly Mapping — 2:00 AM every Sunday
// ---------------------------------------------------------------------------

async function runWeeklyMapping(slackClient) {
  if (!getProvider()) { console.log('[WeeklyMapping] No API key — skipped.'); return; }

  // Use real Slack interactions when a client is provided; fall back to the
  // simulated feed so the function still works standalone in tests.
  const interactions = slackClient
    ? await fetchSlackInteractions(slackClient)
    : await getSimulatedInteractions();

  if (interactions.length === 0) {
    console.log('[WeeklyMapping] No interaction data — skipped.');
    return;
  }

  const prompt = `Analyze these 30-day interaction counts and compute a Dependency Score (1-10) per user pair.
Scoring: 9-10 = critical daily collaborators, 7-8 = high, 5-6 = moderate, 3-4 = low, 1-2 = minimal.

Data:
${interactions.map(i => `- ${i.userA} <-> ${i.userB}: ${i.messages} msgs, ${i.replies} replies, ${i.reactions} reactions`).join('\n')}

Output ONLY a JSON array (no prose):
[{"userId":"...","peerId":"...","score":N}, ...]
Include both directions (A->B and B->A).`;

  console.log('[WeeklyMapping] Starting dependency graph rebuild...');
  const raw = await complete('You are HybridSync\'s dependency graph calculator. Output only valid JSON.', prompt);
  if (!raw) return;

  try {
    const clean  = raw.replace(/```(?:json)?/g, '').trim();
    const parsed = JSON.parse(clean);
    const edges  = Array.isArray(parsed) ? parsed : (parsed.dependencies || parsed.edges || []);

    const byUser = {};
    for (const e of edges) {
      if (!byUser[e.userId]) byUser[e.userId] = [];
      byUser[e.userId].push({ peerId: e.peerId, score: e.score });
    }
    for (const [userId, peerEdges] of Object.entries(byUser)) {
      await db._updateDependencies(userId, peerEdges);
    }
    console.log(`[WeeklyMapping] Rebuilt: ${edges.length} edges across ${Object.keys(byUser).length} users.`);
  } catch (err) {
    console.error('[WeeklyMapping] Failed to parse output:', err.message, '\nRaw:', raw?.slice(0, 200));
  }
}

// Fallback used when no slackClient is available (unit tests, manual triggers)
async function getSimulatedInteractions() {
  return [
    { userA: 'U0B3PJ1QP1B', userB: 'U0B3WJ5RQ3W', messages: 87, replies: 45, reactions: 23 },
    { userA: 'U0B3PJ1QP1B', userB: 'U_RIYA',       messages: 62, replies: 30, reactions: 18 },
    { userA: 'U0B3WJ5RQ3W', userB: 'U_RIYA',        messages: 41, replies: 20, reactions: 12 },
    { userA: 'U0B3PJ1QP1B', userB: 'U_KARAN',       messages: 15, replies:  6, reactions:  4 },
    { userA: 'U0B3WJ5RQ3W', userB: 'U_KARAN',       messages:  8, replies:  2, reactions:  1 },
  ];
}

// ---------------------------------------------------------------------------
// Register cron jobs — slackClient passed in from app.js
// ---------------------------------------------------------------------------

function start(slackClient) {
  cron.schedule('0 7 * * *', () => runDailySweep().catch(e => console.error('[DailySweep] Error:', e.message)));
  cron.schedule('0 2 * * 0', () => runWeeklyMapping(slackClient).catch(e => console.error('[WeeklyMapping] Error:', e.message)));
  console.log('[Batch] Scheduled: daily sweep 7 AM, weekly mapping Sun 2 AM.');
}

module.exports = { start, runDailySweep, runWeeklyMapping, fetchSlackInteractions };
