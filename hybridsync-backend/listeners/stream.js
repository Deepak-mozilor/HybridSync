const db = require('../db');
const { todayKey, parseTargetDate, toKey } = require('../utils/dates');
const { publishHome } = require('../views/appHome');
const orchestrator = require('../ai/orchestrator');
const { resolveDisplayName } = require('./appHome');
const { assignUserToChannel } = require('../services/teamSync');
const { notifyDependents } = require('../services/notifications');
const Anthropic = require('@anthropic-ai/sdk');

const STATUS_EMOJI = { WFH: '🏠', Office: '🏢', Sick: '🤒', Leave: '🌴' };

// Pre-filter: skip API call if message has no status-related words at all.
const STATUS_WORDS_RE = /\b(wfh|wfo|office|home|sick|leave|remote|working|coming in|in today)\b/i;

const DETECT_SYSTEM = `You are a Slack message classifier for a hybrid-work scheduling app.
Decide if a message is the sender personally announcing their own work status for a specific day.

Respond with ONLY a JSON object — no explanation, no markdown:
{"isUpdate":true,"status":"WFH","dateHint":"today"}

Fields:
- isUpdate: true only if the sender is stating their OWN status (not asking about others, not a general question)
- status: "WFH" | "Office" | "Sick" | "Leave"  (null if isUpdate is false)
- dateHint: "today" | "tomorrow" | a day name like "monday" | null

Rules:
- "not wfh" / "won't be wfh" → Office
- "not in office" / "won't be in office" → WFH
- Questions ("who is wfh?") → isUpdate: false
- Talking about others ("John is wfh") → isUpdate: false
- Non-English messages: apply the same logic to their meaning
- If the status or date cannot be determined → isUpdate: false`;

const _anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

async function detectStatusAI(text) {
  if (!STATUS_WORDS_RE.test(text)) return null;
  if (!_anthropic) return null;
  try {
    const response = await _anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001', // cheap + fast — ideal for classification
      max_tokens: 64,
      system: [{ type: 'text', text: DETECT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Message: "${text}"` }],
    });
    const raw  = response.content.find(b => b.type === 'text')?.text || '{}';
    const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (!json.isUpdate || !json.status) return null;
    return { status: json.status, dateHint: json.dateHint || 'today' };
  } catch {
    return null;
  }
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

  app.message(async ({ message, say, client, logger }) => {
    if (message.subtype || message.bot_id) return;
    if (message.channel_type === 'im') return; // DMs handled by chatbot listener

    const text = message.text || '';
    const hit  = await detectStatusAI(text);
    if (!hit) return;

    try {
      const displayName = await resolveDisplayName(client, message.user);
      await db.ensureUser(message.user, { displayName });
      await assignUserToChannel(client, message.user, message.channel);

      // Use AI-supplied dateHint if available, otherwise fall back to text parsing.
      const parsed   = parseTargetDate(hit.dateHint !== 'today' ? (hit.dateHint + ' ' + text) : text);
      const dateKey  = parsed.dateKey;
      const label    = parsed.label;
      const isToday  = dateKey === todayKey();

      const today   = todayKey();
      const maxDate = new Date(); maxDate.setMonth(maxDate.getMonth() + 1);
      const maxKey  = toKey(maxDate);
      if (dateKey < today) {
        await say({ text: "❌ Can't change status for past dates.", thread_ts: message.ts });
        return;
      }
      if (dateKey > maxKey) {
        await say({ text: "❌ Can't schedule more than 1 month ahead.", thread_ts: message.ts });
        return;
      }

      await db.setStatus(message.user, dateKey, hit.status);

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
    } catch (err) {
      logger.error('Stream listener error:', err);
    }
  });
}

module.exports = { register };
