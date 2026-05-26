// Provider abstraction: auto-detects Anthropic or Groq based on env vars.
// Priority: ANTHROPIC_API_KEY first, then GROQ_API_KEY.
//
// Both providers expose the same interface:
//   runAgentLoop(systemPrompt, userMessage, tools, execTool) → string

const Anthropic = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');

// Groq model is env-overridable so we can hot-swap without a redeploy when one
// model regresses on tool calls. Default is Kimi K2 — historically the most
// reliable tool-use model on Groq. Other strong candidates if Kimi misbehaves:
//   meta-llama/llama-4-maverick-17b-128e-instruct
//   meta-llama/llama-4-scout-17b-16e-instruct
//   gpt-oss-120b
// Avoid llama-3.3-70b-versatile for tool-heavy prompts — its <function=...>
// text-format tool calls trip the Groq server-side parser.
const GROQ_MODEL = process.env.GROQ_MODEL || 'moonshotai/kimi-k2-instruct';

// Convert Anthropic-style tool definitions to OpenAI/Groq format
function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// Mark the last tool with cache_control so the whole tools block (plus the
// already-cached system prompt) lives in Anthropic's ephemeral cache. On
// iteration 2+ of the agent loop — and on any chat within ~5 min — tools are
// billed at the ~10% cache-read rate instead of in full each time.
function withToolsCached(tools) {
  if (!tools || tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
  );
}

// --- Anthropic provider ---
async function runWithAnthropic(systemPrompt, userMessage, tools, execTool, priorMessages = []) {
  const client = new Anthropic();
  const messages = [...priorMessages, { role: 'user', content: userMessage }];
  const cachedTools = withToolsCached(tools);

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, iterations: 0 };

  for (let i = 0; i < 8; i++) {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: cachedTools,
      messages,
    });

    const u = response.usage || {};
    totals.input      += u.input_tokens || 0;
    totals.output     += u.output_tokens || 0;
    totals.cacheRead  += u.cache_read_input_tokens || 0;
    totals.cacheWrite += u.cache_creation_input_tokens || 0;
    totals.iterations++;

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      logUsage('anthropic', totals);
      return response.content.find(b => b.type === 'text')?.text || '';
    }
    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of response.content.filter(b => b.type === 'tool_use')) {
      const result = await execTool(block.name, block.input);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  logUsage('anthropic', totals);
  return '';
}

function logUsage(provider, t) {
  // Stays in Railway/server logs — never reaches the Slack user.
  const total = t.input + t.output + t.cacheRead + t.cacheWrite;
  console.log(
    `[AI:${provider}] tokens — input=${t.input} output=${t.output} ` +
    `cacheRead=${t.cacheRead} cacheWrite=${t.cacheWrite} total=${total} ` +
    `iterations=${t.iterations}`
  );
}

// --- Groq provider (OpenAI-compatible) ---
async function runWithGroq(systemPrompt, userMessage, tools, execTool, priorMessages = []) {
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  const messages = [
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: userMessage },
  ];
  const openAITools = toOpenAITools(tools);
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, iterations: 0 };

  for (let i = 0; i < 8; i++) {
    const response = await client.chat.completions.create({
      model: GROQ_MODEL,
      messages,
      tools: openAITools,
      tool_choice: 'auto',
    });

    const u = response.usage || {};
    totals.input  += u.prompt_tokens || 0;
    totals.output += u.completion_tokens || 0;
    totals.iterations++;

    const msg = response.choices[0].message;
    messages.push(msg);

    if (response.choices[0].finish_reason === 'stop') {
      logUsage('groq', totals);
      return msg.content || '';
    }
    if (response.choices[0].finish_reason !== 'tool_calls') break;

    for (const tc of msg.tool_calls || []) {
      const input = JSON.parse(tc.function.arguments);
      const result = await execTool(tc.function.name, input);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  logUsage('groq', totals);
  return '';
}

// --- Public interface ---
function getProvider() {
  if (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('your-')) {
    return 'anthropic';
  }
  if (process.env.GROQ_API_KEY) return 'groq';
  return null;
}

// Errors where Anthropic clearly can't serve this call but Groq might.
// 401/403 = key/permission, 429 = rate limit, 5xx = upstream outage, no status
// at all = network failure. 400 / 404 stay un-fallbacked because they signal a
// bug in our request shape (model name typo, malformed messages) that Groq
// would hit the same way.
function shouldFallbackFromAnthropic(err) {
  const status = err?.status || err?.response?.status;
  if (!status) return true;
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

async function runAgentLoop(systemPrompt, userMessage, tools, execTool, priorMessages = []) {
  const provider = getProvider();
  if (!provider) {
    console.log('[AI] No valid API key found — skipping AI features.');
    return null;
  }

  if (provider === 'anthropic') {
    try {
      console.log('[AI] Using provider: anthropic');
      return await runWithAnthropic(systemPrompt, userMessage, tools, execTool, priorMessages);
    } catch (err) {
      if (process.env.GROQ_API_KEY && shouldFallbackFromAnthropic(err)) {
        const status = err?.status || err?.response?.status || 'network';
        const type   = err?.error?.error?.type || err?.error?.type || err?.constructor?.name;
        console.warn(`[AI] Anthropic failed (status=${status}, type=${type}) — falling back to Groq`);
        return runWithGroq(systemPrompt, userMessage, tools, execTool, priorMessages);
      }
      throw err;
    }
  }

  console.log('[AI] Using provider: groq');
  return runWithGroq(systemPrompt, userMessage, tools, execTool, priorMessages);
}

async function completeWithAnthropic(systemPrompt, userMessage) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });
  const u = response.usage || {};
  logUsage('anthropic', {
    input:      u.input_tokens || 0,
    output:     u.output_tokens || 0,
    cacheRead:  u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    iterations: 1,
  });
  return response.content.find(b => b.type === 'text')?.text || '';
}

async function completeWithGroq(systemPrompt, userMessage) {
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });
  const response = await client.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });
  const u = response.usage || {};
  logUsage('groq', {
    input:      u.prompt_tokens || 0,
    output:     u.completion_tokens || 0,
    cacheRead:  0,
    cacheWrite: 0,
    iterations: 1,
  });
  return response.choices[0].message.content || '';
}

// Lightweight single-call completion (no tool loop) — used by batch jobs.
// Mirrors runAgentLoop's fallback behaviour.
async function complete(systemPrompt, userMessage) {
  const provider = getProvider();
  if (!provider) return null;

  if (provider === 'anthropic') {
    try {
      return await completeWithAnthropic(systemPrompt, userMessage);
    } catch (err) {
      if (process.env.GROQ_API_KEY && shouldFallbackFromAnthropic(err)) {
        const status = err?.status || err?.response?.status || 'network';
        console.warn(`[AI:complete] Anthropic failed (status=${status}) — falling back to Groq`);
        return completeWithGroq(systemPrompt, userMessage);
      }
      throw err;
    }
  }

  return completeWithGroq(systemPrompt, userMessage);
}

module.exports = { runAgentLoop, complete, getProvider };
