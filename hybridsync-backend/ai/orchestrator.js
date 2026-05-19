// The Agentic Brain — ReAct (Reason + Act) loop.
// Works with Anthropic (claude-opus-4-7) or Groq (llama-3.3-70b-versatile).
// Triggered whenever a user changes their status today. Goal: minimize collaboration loss.

const db = require('../db');
const { runAgentLoop } = require('./provider');

const STATUS_EMOJI = { WFH: '🏠', Office: '🏢', Sick: '🤒', Leave: '🌴' };

const SYSTEM_PROMPT = `You are HybridSync's scheduling orchestrator. Your sole goal is to MINIMIZE COLLABORATION LOSS.

When a team member changes their work location, you must:
1. Use get_dependency_graph to identify their high-priority collaborators (score >= 7).
2. For each high-priority collaborator whose current status differs, use send_negotiation_dm to let them decide whether to adjust.
3. Only send a DM when collaboration loss is genuinely at risk — not speculatively.

Constraints:
- Only act on collaborators with dependency score >= 7.
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
    name: 'send_negotiation_dm',
    description: 'Sends a Slack DM to a collaborator letting them choose whether to adjust their schedule. Never silently changes their schedule.',
    input_schema: {
      type: 'object',
      properties: {
        triggeringUserId: { type: 'string', description: 'The user who changed their status.' },
        peerId:           { type: 'string', description: 'The collaborator to notify.' },
        date:             { type: 'string', description: 'YYYY-MM-DD' },
        newStatus:        { type: 'string', enum: ['WFH', 'Office', 'Sick', 'Leave'] },
        score:            { type: 'number', description: 'Collaboration score 1-10.' },
      },
      required: ['triggeringUserId', 'peerId', 'date', 'newStatus', 'score'],
    },
  },
];

function makeExecTool(slackClient) {
  return async function execTool(toolName, input) {
    console.log(`[Orchestrator] → ${toolName}(${JSON.stringify(input)})`);

    switch (toolName) {
      case 'get_dependency_graph': {
        const edges = await db.getDependencyGraph(input.userId);
        return JSON.stringify(edges);
      }

      case 'send_negotiation_dm': {
        const { triggeringUserId, peerId, date, newStatus, score } = input;
        if (!/^U[A-Z0-9]{6,}$/.test(peerId)) return JSON.stringify({ error: 'Invalid peerId' });

        const peerStatus = await db.getStatusForDate(peerId, date);
        if (peerStatus === newStatus) return JSON.stringify({ skipped: 'already same status' });

        const emoji  = STATUS_EMOJI[newStatus] || '📅';
        const peerCtx = JSON.stringify({ triggeringUserId, date, targetUserId: peerId });

        await slackClient.chat.postMessage({
          channel: peerId,
          text: `<@${triggeringUserId}> switched to ${newStatus} ${emoji}. Want to adjust your schedule?`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: '🤝 HybridSync: Schedule Coordination', emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `<@${triggeringUserId}> just switched to *${newStatus} ${emoji}* on *${date}*.\nYour collaboration score: *${score}/10*\n\nWould you like to adjust your schedule?`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '🏠 Switch to WFH', emoji: true },
                  style: 'primary',
                  value: peerCtx,
                  action_id: 'negotiation_switch_wfh',
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '🏢 Stay in Office', emoji: true },
                  value: peerCtx,
                  action_id: 'negotiation_stay_office',
                },
              ],
            },
          ],
        });
        console.log(`[Orchestrator] DM sent → ${peerId} about ${triggeringUserId} → ${newStatus}`);
        return JSON.stringify({ sent: true, peerId });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  };
}

async function run(triggeringUserId, date, newStatus, slackClient) {
  const userMessage = `User ${triggeringUserId} just changed their status to ${newStatus} on ${date}. Analyze their dependency graph and notify collaborators who may be impacted.`;

  try {
    await runAgentLoop(SYSTEM_PROMPT, userMessage, TOOLS, makeExecTool(slackClient));
  } catch (err) {
    console.error('[Orchestrator] Error:', err.message);
  }
}

module.exports = { run };
