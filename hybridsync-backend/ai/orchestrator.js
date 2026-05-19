// The Agentic Brain — ReAct (Reason + Act) loop.
// Works with Anthropic (claude-opus-4-7) or Groq (llama-3.3-70b-versatile).
// Triggered whenever a user changes their status. Goal: minimize collaboration loss.

const db = require('../db');
const { runAgentLoop } = require('./provider');

const SYSTEM_PROMPT = `You are HybridSync's scheduling orchestrator. Your sole goal is to MINIMIZE COLLABORATION LOSS.

When a team member changes their work location, you must:
1. Use get_dependency_graph to identify their high-priority collaborators (score >= 7).
2. If a collaborator's schedule would clearly benefit from being updated to match, use update_schedule_db.
3. Only call update_schedule_db when a definitive schedule change is clearly the right action — not speculatively.

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

function makeExecTool() {
  return async function execTool(toolName, input) {
    console.log(`[Orchestrator] → ${toolName}(${JSON.stringify(input)})`);

    switch (toolName) {
      case 'get_dependency_graph': {
        const edges = await db.getDependencyGraph(input.userId);
        return JSON.stringify(edges);
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

async function run(triggeringUserId, date, newStatus) {
  const userMessage = `User ${triggeringUserId} just changed their status to ${newStatus} on ${date}. Analyze their dependency graph and take all necessary actions to minimize collaboration loss.`;

  try {
    await runAgentLoop(SYSTEM_PROMPT, userMessage, TOOLS, makeExecTool());
  } catch (err) {
    console.error('[Orchestrator] Error:', err.message);
  }
}

module.exports = { run };
