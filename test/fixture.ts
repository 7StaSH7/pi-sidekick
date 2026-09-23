// Offline integration fixture. Never shipped as an extension resource.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { TOOL, WORKER_ENV } from '../policy.mjs';

export const TEST_LEAD = { provider: 'anthropic', id: 'fixture-lead', thinking: 'medium' };
export const TEST_SIDEKICK = { provider: 'openai-codex', id: 'gpt-5.6-luna', thinking: 'max' };
export const ALT_SIDEKICK = { provider: 'openai', id: 'fixture-sidekick', thinking: 'high' };
const modelSpec = model => ({
  id: model.id,
  name: model.id,
  reasoning: true,
  thinkingLevelMap: model === ALT_SIDEKICK
    ? { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }
    : { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  input: ['text'],
  cost: model === TEST_LEAD
    ? { input: 4, output: 12, cacheRead: 1, cacheWrite: 4 }
    : model === TEST_SIDEKICK
      ? { input: 1, output: 3, cacheRead: 0.25, cacheWrite: 1 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 4096,
});

export default function fixture(pi: any) {
  if (process.env.PI_FUSION_TEST !== '1') throw new Error('Test fixture must not load outside isolated tests.');
  const log = (data: any) => appendFileSync(process.env.PI_FUSION_TEST_LOG!, JSON.stringify(data) + '\n');
  const child = process.env[WORKER_ENV] === '1';
  const modelsByProvider: Record<string, any[]> = {
    anthropic: [TEST_LEAD],
    'openai-codex': [TEST_SIDEKICK],
    openai: [ALT_SIDEKICK],
  };
  const streamSimple = (model: any, context: any, options: any) => {
    const stream = createAssistantMessageEventStream();
    const textOf = (m: any) => typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    const user = context.messages.findLast((m: any) => m.role === 'user');
    const prompt = textOf(user);
    const last = context.messages.at(-1);
    const promptIndex = context.messages.findLastIndex((message: any) => message.role === 'user');
    const taskResults = context.messages.slice(promptIndex + 1).filter((message: any) => message.role === 'toolResult');
    log({ model: model.id, provider: model.provider, thinking: options?.reasoning, child, prompt, users: context.messages.filter((m: any) => m.role === 'user').length });
    const call = (name: string, args: any) => ({ type: 'toolCall', id: randomUUID(), name, arguments: args });
    let content: any[];
    let stopReason = 'stop';
    if (child && prompt.includes('TOOL_STORM_65')) {
      content = taskResults.length < 65 ? [call('read', { path: 'input.txt' })] : [{ type: 'text', text: `LUNA completed ${taskResults.length} calls` }];
      stopReason = taskResults.length < 65 ? 'toolUse' : 'stop';
    } else if (last?.role === 'toolResult') {
      const users = context.messages.filter((m: any) => m.role === 'user').length;
      content = [{ type: 'text', text: `${child ? 'LUNA' : 'LEAD'} REPORT history=${users}: ${textOf(last)}` }];
    } else if (!child) {
      content = [call(TOOL, { brief: prompt, constraints: 'Only use this temporary test workspace.', success_criteria: 'Report the actual tool result.' })];
      if (prompt.includes('SIBLING')) content.unshift(call('write', { path: 'lead-must-not-write.txt', content: 'bad' }));
      stopReason = 'toolUse';
    } else if (prompt.includes('FAIL')) {
      content = []; stopReason = 'error';
    } else {
      content = [prompt.includes('WAIT') ? call('bash', { command: 'sleep 30' })
        : prompt.includes('PERMISSION') ? call('write', { path: 'denied.txt', content: 'must not appear' })
        : prompt.includes('WRITE') ? call('write', { path: 'output.txt', content: 'written by Luna' })
        : call('read', { path: 'input.txt' })];
      stopReason = 'toolUse';
    }
    const inputCost = 10 * model.cost.input / 1_000_000;
    const outputCost = 5 * model.cost.output / 1_000_000;
    const message = {
      role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0, total: inputCost + outputCost } },
      stopReason, timestamp: Date.now(), ...(stopReason === 'error' ? { errorMessage: 'Deliberate offline fixture failure' } : {}),
    };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      stream.push(stopReason === 'error' ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: stopReason, message });
      stream.end();
    });
    return stream;
  };
  for (const [provider, models] of Object.entries(modelsByProvider)) {
    pi.registerProvider(provider, {
      api: 'fusion-offline-test',
      ...(process.env.PI_FUSION_TEST_NO_AUTH === '1' ? {} : { apiKey: 'offline-fixture-not-a-real-key' }),
      baseUrl: 'http://127.0.0.1:9',
      models: models.map(modelSpec),
      streamSimple,
    });
  }
  pi.on('tool_call', async (event: any, ctx: any) => {
    log({ hook: event.toolName, child: process.env[WORKER_ENV] === '1' });
    if (event.toolName === 'write' && event.input.path === 'denied.txt') {
      const allowed = await ctx.ui.confirm('Fixture permission gate', 'Allow denied.txt?');
      if (!allowed) return { block: true, reason: 'Denied by native test permission hook' };
    }
  });
}
