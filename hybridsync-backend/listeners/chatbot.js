const db              = require('../db');
const { chat }        = require('../ai/chatbot');
const { upcomingWorkDays, todayKey } = require('../utils/dates');

const STATUS_EMOJI = { WFH: '🏠', Office: '🏢', Sick: '🤒', Leave: '🌴' };

// In-memory set — prevents sending the welcome message twice per session.
const welcomed = new Set();

async function buildWelcomeBlocks() {
  const week     = upcomingWorkDays(5);
  const today    = todayKey();
  const users    = await db.getAllUsers();
  const dateKeys = week.map(w => w.dateKey);

  // Emojis are double-width in monospace. Col width = 5 visual chars.
  // Header cell: "Mon  " = 3 + 2 spaces = 5 chars
  // Emoji cell:  "🏢   " = 2 (emoji) + 3 spaces = 5 visual chars
  const allSchedules = [];
  for (const user of users) {
    const sched = await db.getScheduleForDates(user.id, dateKeys);
    allSchedules.push({ name: user.displayName, sched });
  }

  const nameWidth  = Math.max(...allSchedules.map(r => r.name.length), 4) + 2;
  const headerPad  = ' '.repeat(nameWidth);
  const dayHeaders = week.map(w => w.day.padEnd(5)).join('');
  const divider    = '─'.repeat(nameWidth + 5 * week.length);

  const rows = allSchedules.map(({ name, sched }) => {
    const cells = sched.map(s => (STATUS_EMOJI[s.status] || '? ') + '   ').join('');
    return name.padEnd(nameWidth) + cells;
  });

  const table = [headerPad + dayHeaders, divider, ...rows].join('\n');

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '👋 Welcome to HybridSync Assistant', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Here's your team's schedule for the next 5 days:\n\`\`\`\n${table}\n\`\`\``,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '🏠 WFH  ·  🏢 Office  ·  🤒 Sick  ·  🌴 Leave' },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Ask me anything, for example:*\n• _Is Jithu WFH on Wednesday?_\n• _Who\'s in the office on Thursday?_\n• _Set me as WFH tomorrow_\n• _What\'s the team schedule this week?_',
      },
    },
  ];
}

async function sendWelcome(client, userId) {
  if (welcomed.has(userId)) return;
  welcomed.add(userId); // mark immediately to prevent races
  try {
    const blocks = await buildWelcomeBlocks();
    await client.chat.postMessage({ channel: userId, text: '👋 Welcome to HybridSync Assistant!', blocks });
    console.log(`[Chatbot] Sent welcome to ${userId}`);
  } catch (err) {
    console.error('[Chatbot] Failed to send welcome:', err.message);
  }
}

function register(app) {
  // Send welcome snapshot when user first opens the Messages tab with the bot.
  app.event('app_home_opened', ({ event, client }) => {
    if (event.tab !== 'messages') return;
    sendWelcome(client, event.user).catch(() => {});
  });

  // Handle all DMs.
  app.message(async ({ message, client, logger }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype || message.bot_id) return;

    // Send welcome only if app_home_opened never fired (fallback).
    if (!welcomed.has(message.user)) await sendWelcome(client, message.user);

    const question = (message.text || '').trim();
    if (!question) return;

    try {
      const reply = await chat(message.user, question);
      if (reply) {
        await client.chat.postMessage({ channel: message.channel, text: reply });
      }
    } catch (err) {
      logger.error('[Chatbot] Error:', err);
      await client.chat.postMessage({
        channel: message.channel,
        text: "Sorry, I hit an error. Try asking something like: _Is Jithu WFH on Wednesday?_",
      });
    }
  });
}

module.exports = { register };
