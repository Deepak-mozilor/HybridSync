const db = require('../db');
const { todayKey, toKey } = require('../utils/dates');

// Pretty label for an ISO dateKey, given today's ISO dateKey.
// "tomorrow (Sat May 23)" / "Monday May 25"
function labelForDateKey(dateKey, today) {
  const todayDate = new Date(today   + 'T00:00:00');
  const target    = new Date(dateKey + 'T00:00:00');
  const diffDays  = Math.round((target - todayDate) / 86400000);
  const pretty    = target.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  if (diffDays === 1) return `tomorrow (${pretty})`;
  return pretty;
}
const { publishHome } = require('../views/appHome');
const orchestrator = require('../ai/orchestrator');
const { resolveDisplayName } = require('./appHome');
const { assignUserToChannel } = require('../services/teamSync');
const { notifyDependents, shouldNotify } = require('../services/notifications');
const { checkWFHConflict } = require('../services/calendarAlerts');
const Anthropic = require('@anthropic-ai/sdk');

const STATUS_EMOJI = { WFH: '🏠', Office: '🏢', Sick: '🤒', Leave: '🌴' };

// Pre-filter: skip API call if message has no status-related words at all.
const STATUS_WORDS_RE = /\b(wfh|wfo|office|home|sick|leave|remote|working|coming in|in today)\b/i;

const DETECT_SYSTEM = `You are a Slack message classifier for a hybrid-work scheduling app.
Decide if a message is the sender personally announcing their own work status for a specific day.

Respond with ONLY a JSON object — no explanation, no markdown:
{"isUpdate":true,"status":"WFH","dateKey":"2026-05-22"}

Fields:
- isUpdate: true only if the sender is stating their OWN status (not asking about others, not a general question)
- status: "WFH" | "Office" | "Sick" | "Leave"  (null if isUpdate is false)
- dateKey: ISO date in YYYY-MM-DD format. Resolve any date reference relative to TODAY (provided in the user message): "today" / "tdy", "tomorrow" / "tmr" / "tmrw" / "tmw" / "tom", weekday names ("monday" / "mon", "tuesday" / "tue" / "tues", etc.), absolute dates ("june 2", "Jun 2nd", "2026-06-02", "next friday"), or "next week" (= next Monday). If no date is mentioned, default to today.

Rules:
- "not wfh" / "won't be wfh" → Office
- "not in office" / "won't be in office" → WFH
- Questions ("who is wfh?") → isUpdate: false
- Talking about others ("John is wfh") → isUpdate: false
- Non-English messages: apply the same logic to their meaning
- If the status cannot be determined → isUpdate: false
- For absolute dates without a year ("june 2"), pick the NEXT occurrence — if that date has passed this year, use next year`;

const _anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isTransientApiError(e) {
  const status = e?.status;
  const type   = e?.error?.error?.type || e?.error?.type;
  return status === 529 || status === 503 || status === 502 || status === 429 || type === 'overloaded_error';
}

// Multi-attempt schedule: 3 Haiku tries (longer backoff than before to ride
// out 5–10s Anthropic spikes), then a single Sonnet fallback (different
// model queue, often available when Haiku is overloaded).
const CLASSIFIER_ATTEMPTS = [
  { model: 'claude-haiku-4-5-20251001', delay: 0    },
  { model: 'claude-haiku-4-5-20251001', delay: 1000 },
  { model: 'claude-haiku-4-5-20251001', delay: 3000 },
  { model: 'claude-sonnet-4-6',         delay: 1500 },
];

// Returns one of:
//   { kind: 'skip' }                  — pre-filter didn't match, or no API key
//   { kind: 'no_match' }              — classifier ran but decided this isn't a status update
//   { kind: 'unavailable', error }    — Anthropic API failed transiently after retries
//   { kind: 'hit', status, dateKey }  — successful classification
async function detectStatusAI(text) {
  if (!STATUS_WORDS_RE.test(text)) return { kind: 'skip' };
  if (!_anthropic) return { kind: 'skip' };

  let lastErr = null;

  for (let i = 0; i < CLASSIFIER_ATTEMPTS.length; i++) {
    const { model, delay } = CLASSIFIER_ATTEMPTS[i];
    if (delay) await sleep(delay);
    try {
      const response = await _anthropic.messages.create({
        model,
        max_tokens: 80,
        system: [{ type: 'text', text: DETECT_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `TODAY: ${todayKey()}\nMessage: "${text}"` }],
      });
      const raw  = response.content.find(b => b.type === 'text')?.text || '{}';
      const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (model !== CLASSIFIER_ATTEMPTS[0].model) {
        console.log(`[Stream] classifier recovered via ${model} on attempt ${i + 1}`);
      }
      if (!json.isUpdate || !json.status) return { kind: 'no_match' };
      return { kind: 'hit', status: json.status, dateKey: json.dateKey || todayKey() };
    } catch (e) {
      lastErr = e;
      if (!isTransientApiError(e)) break;
    }
  }
  console.warn('[Stream] classifier failed after retries:', lastErr?.status, lastErr?.message);
  return { kind: 'unavailable', error: lastErr };
}

const STATUS_EMOJI_MAP = { WFH: 'house', Office: 'office', Sick: 'face_with_thermometer', Leave: 'palm_tree' };

function register(app) {
  // Persist any user the moment they join a channel the bot is in.
  app.event('member_joined_channel', async ({ event, client, logger }) => {
    if (event.user === event.bot_id) return; // ignore the bot itself joining
    try {
      const displayName = await resolveDisplayName(client, event.user);
      await db.ensureUser(event.user, { displayName });
      await assignUserToChannel(client, event.user, event.channel);
      console.log(`[Stream] New member: ${displayName} (${event.user}) joined channel ${event.channel}`);
    } catch (err) {
      logger.error('[Stream] member_joined_channel error:', err);
    }
  });

  // The bot itself was removed from a channel — delete the team and its memberships.
  // `channel_left` fires for public channels, `group_left` for private ones.
  const onBotLeft = async ({ event, logger }) => {
    try {
      const team = await db.getTeam(event.channel);
      await db.deleteTeam(event.channel);
      console.log(`[Stream] Bot removed from #${team?.name || event.channel} — team deleted`);
    } catch (err) {
      logger.error('[Stream] team delete on bot-leave failed:', err);
    }
  };
  app.event('channel_left', onBotLeft);
  app.event('group_left',   onBotLeft);

  app.message(async ({ message, say, client, logger }) => {
    if (message.subtype || message.bot_id) return;
    if (message.channel_type === 'im') return; // DMs handled by chatbot listener

    const text   = message.text || '';
    const result = await detectStatusAI(text);
    if (result.kind === 'skip' || result.kind === 'no_match') return;

    if (result.kind === 'unavailable') {
      try {
        await say({
          text: '⚠️ Status classifier is temporarily unavailable. Open the HybridSync app home and use *✏️ Edit Schedule* to set your status manually.',
          thread_ts: message.ts,
        });
      } catch {}
      return;
    }

    const hit = result; // { kind: 'hit', status, dateKey }

    try {
      const displayName = await resolveDisplayName(client, message.user);
      await db.ensureUser(message.user, { displayName });
      await assignUserToChannel(client, message.user, message.channel);

      const dateKey = hit.dateKey;
      const today   = todayKey();
      const isToday = dateKey === today;
      const label   = isToday ? 'today' : labelForDateKey(dateKey, today);

      const maxDate = new Date(); maxDate.setMonth(maxDate.getMonth() + 1);
      const maxKey  = toKey(maxDate);
      if (dateKey > maxKey) {
        await say({ text: "❌ Can't schedule more than 1 month ahead.", thread_ts: message.ts });
        return;
      }

      try {
        await db.setStatus(message.user, dateKey, hit.status);
      } catch (e) {
        await say({ text: `❌ ${e.message}`, thread_ts: message.ts });
        return;
      }
      checkWFHConflict(client, message.user, dateKey, hit.status).catch(() => {});

      await say({
        text: `✅ Got it! Your HybridSync status is *${hit.status}* for *${label}*.`,
        thread_ts: message.ts,
      });

      const emojiName = STATUS_EMOJI_MAP[hit.status];
      try {
        await client.reactions.add({ channel: message.channel, name: emojiName, timestamp: message.ts });
      } catch (e) {
        if (e?.data?.error !== 'already_reacted') logger.warn('reaction failed:', e?.data?.error || e.message);
      }

      await publishHome(client, message.user);
      console.log(`[Stream] ${displayName} (${message.user}) → ${hit.status} on ${dateKey}`);

      if (shouldNotify(message.user, dateKey)) {
        if (isToday) {
          // Orchestrator handles today — sends negotiation DMs to collaborators.
          orchestrator.run(message.user, dateKey, hit.status, client).catch(e =>
            logger.error('[Orchestrator] Background error:', e)
          );
        } else {
          // Future date — no orchestrator, notify dependents directly.
          notifyDependents(client, message.user, dateKey, hit.status).catch(e =>
            logger.error('[Stream] notifyDependents error:', e)
          );
        }
      }
    } catch (err) {
      logger.error('Stream listener error:', err);
    }
  });
}

module.exports = { register };
