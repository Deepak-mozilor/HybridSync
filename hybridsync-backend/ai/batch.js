// Scheduled AI batch jobs.
// Weekly Map (Sun 2:00 AM) — Recalculates dependency graph from 30-day Slack interactions.
// Works with Anthropic or Groq via the provider abstraction.

const cron = require('node-cron');
const db = require('../db');
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

    // Save manual edges before wiping — they will be restored after.
    const manualEdges = await db.getAllManualDependencies();

    // Wipe all existing edges so stale scores don't persist.
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await supabase.from('dependencies').delete().neq('user_id', '');

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

// Fallback used when no slackClient is available (unit tests, manual triggers)
async function getSimulatedInteractions() {
  return [
    { userA: 'U0B3PJ1QP1B', userB: 'U0B3WJ5RQ3W', messages: 87, replies: 45, reactions: 23 },
  ];
}

// ---------------------------------------------------------------------------
// Register cron jobs — slackClient passed in from app.js
// ---------------------------------------------------------------------------

function start(slackClient) {
  cron.schedule('0 2 * * 0', () => runWeeklyMapping(slackClient).catch(e => console.error('[WeeklyMapping] Error:', e.message)));
  console.log('[Batch] Scheduled: weekly mapping Sun 2 AM.');
}

module.exports = { start, runWeeklyMapping, fetchSlackInteractions };
