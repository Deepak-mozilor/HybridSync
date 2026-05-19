const db = require('../db');
const { upcomingWorkDays, todayKey } = require('../utils/dates');
const { runAgentLoop } = require('./provider');
const orchestrator = require('./orchestrator');
const { notifyDependents } = require('../services/notifications');

// Per-user conversation history (in-memory, resets on restart).
// Stores plain text exchanges only — no tool call payloads.
const MAX_HISTORY = 10; // messages = 5 back-and-forth turns
const history = new Map();

const STATUS_EMOJI = { WFH: '🏠', Office: '🏢', Sick: '🤒', Leave: '🌴' };

const TOOLS = [
  {
    name: 'find_user',
    description: 'Find a team member by their display name (case-insensitive, partial match). Use this before calling get_user_schedule.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name or partial name to search for, e.g. "Jithu" or "riya"' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_user_schedule',
    description: 'Get a team member\'s work status for one or more dates.',
    input_schema: {
      type: 'object',
      properties: {
        userId:  { type: 'string', description: 'User ID returned by find_user' },
        dates:   { type: 'array', items: { type: 'string' }, description: 'Dates in YYYY-MM-DD format' },
      },
      required: ['userId', 'dates'],
    },
  },
  {
    name: 'get_team_schedule',
    description: 'Get the full team\'s schedule for the next 5 work days. Use for questions like "who is in the office this week?" or "team overview".',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'set_my_status',
    description: 'Update the requesting user\'s own work status for a given date.',
    input_schema: {
      type: 'object',
      properties: {
        date:   { type: 'string', description: 'Date in YYYY-MM-DD format' },
        status: { type: 'string', enum: ['WFH', 'Office', 'Sick', 'Leave'] },
      },
      required: ['date', 'status'],
    },
  },
];

async function chat(requestingUserId, userMessage, slackClient) {
  const week  = upcomingWorkDays(5);
  const today = todayKey();
  const weekContext = week.map(w => `${w.day} ${w.dateKey}`).join(', ');

  const systemPrompt = `You are HybridSync's friendly schedule assistant. You help team members check and manage their hybrid work schedules.

Requesting user's Slack ID: ${requestingUserId}
Today: ${today}
Upcoming work days: ${weekContext}

Guidelines:
- To look someone up by name, ALWAYS call find_user first, then get_user_schedule with their userId.
- Use get_team_schedule for broad team overview questions.
- Use set_my_status only when the user explicitly wants to change their own schedule. Only today or future dates are allowed — never set status for a past date.
- Reply conversationally and concisely. Use emojis: 🏠 WFH · 🏢 Office · 🤒 Sick · 🌴 Leave.
- If a user asks about "Wednesday", resolve it using the upcoming work days listed above.
- Never make up schedule data — always call a tool to retrieve it.
- You have access to the recent conversation history — use it for follow-up questions like "what about Thursday?" or "yes" / "no" confirmations.

SLACK FORMATTING RULES (strictly follow these):
- Bold: *text* (single asterisk only — never **)
- Italic: _text_
- Bullet list: start each line with •
- NEVER use Markdown tables (| col | col |) — Slack does not render them. Use bullet lists instead.
- NEVER use ## or # headings.`;

  const execTool = async (toolName, input) => {
    console.log(`[Chatbot] → ${toolName}(${JSON.stringify(input)})`);

    switch (toolName) {
      case 'find_user': {
        const users = await db.findUserByName(input.name);
        return JSON.stringify(users.map(u => ({ id: u.id, name: u.displayName, teamId: u.teamId })));
      }

      case 'get_user_schedule': {
        const schedule = await db.getScheduleForDates(input.userId, input.dates);
        return JSON.stringify(schedule.map(s => ({
          date: s.dateKey,
          day:  s.day,
          status: s.status,
          emoji:  STATUS_EMOJI[s.status] || '❓',
        })));
      }

      case 'get_team_schedule': {
        const users    = await db.getAllUsers();
        const dateKeys = week.map(w => w.dateKey);
        const rows = [];
        for (const user of users) {
          const sched = await db.getScheduleForDates(user.id, dateKeys);
          rows.push({
            name:     user.displayName,
            schedule: sched.map(s => ({ date: s.dateKey, day: s.day, status: s.status, emoji: STATUS_EMOJI[s.status] || '❓' })),
          });
        }
        return JSON.stringify(rows);
      }

      case 'set_my_status': {
        if (input.date < todayKey()) {
          return JSON.stringify({ error: `Cannot update status for a past date (${input.date}). Only today or future dates are allowed.` });
        }
        await db.setStatus(requestingUserId, input.date, input.status);
        notifyDependents(slackClient, requestingUserId, input.date, input.status).catch(e =>
          console.error('[Notify] Chatbot notifyDependents error:', e.message)
        );
        if (input.date === todayKey()) {
          orchestrator.run(requestingUserId, input.date, input.status, slackClient).catch(e =>
            console.error('[Orchestrator] Chatbot trigger error:', e.message)
          );
        }
        return JSON.stringify({ updated: true, date: input.date, status: input.status });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  };

  const priorMessages = history.get(requestingUserId) || [];
  const reply = await runAgentLoop(systemPrompt, userMessage, TOOLS, execTool, priorMessages);

  if (reply) {
    const updated = [
      ...priorMessages,
      { role: 'user',      content: userMessage },
      { role: 'assistant', content: reply },
    ].slice(-MAX_HISTORY);
    history.set(requestingUserId, updated);
  }

  return reply;
}

module.exports = { chat };
