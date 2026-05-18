// The Agentic Brain — ReAct (Reason + Act) loop.
// Works with Anthropic (claude-opus-4-7) or Groq (llama-3.3-70b-versatile).
// Triggered whenever a user changes their status. Goal: minimize collaboration loss.

const db = require('../db');
const { runAgentLoop } = require('./provider');

const SYSTEM_PROMPT = `You are HybridSync's scheduling orchestrator. Your sole goal is to MINIMIZE COLLABORATION LOSS.

When a team member changes their work location, you must:
1. Use get_dependency_graph to identify their high-priority collaborators (score >= 7).
2. For each high-priority collaborator, decide whether sending a negotiation DM is warranted.
3. Only call update_schedule_db when a definitive schedule change is clearly the right action.

Constraints:
- Only reach out to collaborators with dependency score >= 7.
- Send at most 3 negotiation DMs per trigger event to avoid alert fatigue.
- When all necessary actions are complete, stop — do not call extra tools.`;

const TOOLS = [
  {
    name: 'get_dependency_graph',
    description: 'Fetches dependency edges for a given user. Returns [{peerId, score}] where score 1-10 represents collaboration intensity.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Slack user ID to fetch dependencies for.' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'send_slack_negotiation',
    description: 'Sends an interactive Block Kit DM to a Slack user proposing a schedule adjustment because a key collaborator changed their status. Use for dependency score >= 7.',
    input_schema: {
      type: 'object',
      properties: {
        targetUserId:     { type: 'string',  description: 'Slack user ID to DM.' },
        triggeringUserId: { type: 'string',  description: 'Slack user ID who changed their status.' },
        dependencyScore:  { type: 'number',  description: 'Dependency score 1-10.' },
        date:             { type: 'string',  description: 'Date in YYYY-MM-DD format.' },
        triggeringStatus: { type: 'string',  description: 'New status: WFH, Office, or Sick.' },
      },
      required: ['targetUserId', 'triggeringUserId', 'dependencyScore', 'date', 'triggeringStatus'],
    },
  },
  {
    name: 'update_schedule_db',
    description: 'Writes a definitive status change to the database. Only use when the change is certain.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        date:   { type: 'string', description: 'YYYY-MM-DD' },
        status: { type: 'string', enum: ['WFH', 'Office', 'Sick', 'Leave'] },
      },
      required: ['userId', 'date', 'status'],
    },
  },
];

const STATUS_EMOJI = { WFH: '🏠', Office: '🏢', Sick: '🤒', Leave: '🌴' };

function makeExecTool(slackClient) {
  return async function execTool(toolName, input) {
    console.log(`[Orchestrator] → ${toolName}(${JSON.stringify(input)})`);

    switch (toolName) {
      case 'get_dependency_graph': {
        const edges = await db.getDependencyGraph(input.userId);
        return JSON.stringify(edges);
      }

      case 'send_slack_negotiation': {
        const { targetUserId, triggeringUserId, dependencyScore, date, triggeringStatus } = input;
        // Seed users (U_AZHAR, U_ANLIYA, …) aren't real Slack accounts — skip.
        if (!/^U[A-Z0-9]+$/.test(targetUserId)) {
          console.log(`[Orchestrator] Skipping DM to seed user ${targetUserId}`);
          return JSON.stringify({ skipped: true, reason: 'seed user — no real Slack channel' });
        }
        const emoji = STATUS_EMOJI[triggeringStatus] || '📅';
        const ctx = JSON.stringify({ triggeringUserId, date, targetUserId });

        await slackClient.chat.postMessage({
          channel: targetUserId,
          text: `<@${triggeringUserId}> switched to ${triggeringStatus} ${emoji}. Want to adjust your schedule?`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: '🤝 HybridSync: Schedule Coordination', emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `<@${triggeringUserId}> just switched to *${triggeringStatus} ${emoji}* on *${date}*.\nYour collaboration score: *${dependencyScore}/10*\n\nWould you like to adjust your schedule for today?`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '🏠 Switch to WFH', emoji: true },
                  style: 'primary',
                  value: ctx,
                  action_id: 'negotiation_switch_wfh',
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '🏢 Stay in Office', emoji: true },
                  value: ctx,
                  action_id: 'negotiation_stay_office',
                },
              ],
            },
          ],
        });
        return JSON.stringify({ sent: true, targetUserId });
      }

      case 'update_schedule_db': {
        await db.setStatus(input.userId, input.date, input.status);
        return JSON.stringify({ updated: true, ...input });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  };
}

async function run(triggeringUserId, date, newStatus, slackClient) {
  const userMessage = `User ${triggeringUserId} just changed their status to ${newStatus} on ${date}. Analyze their dependency graph and take all necessary actions to minimize collaboration loss.`;

  try {
    await runAgentLoop(SYSTEM_PROMPT, userMessage, TOOLS, makeExecTool(slackClient));
  } catch (err) {
    console.error('[Orchestrator] Error:', err.message);
  }
}

module.exports = { run };
