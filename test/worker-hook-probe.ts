import { writeFileSync } from 'node:fs';
import fusion from '../index.ts';
import { WORKER_CONFIG_ENV } from '../policy.mjs';

export default async function (pi: any) {
  const expected = JSON.parse(process.env[WORKER_CONFIG_ENV] ?? '');
  const handlers: Record<string, any> = {};
  const wrapped = new Proxy(pi, {
    get(target, property) {
      if (property === 'on') {
        return (event: string, handler: any) => {
          if (event === 'tool_call') handlers[event] = handler;
          return target.on(event, handler);
        };
      }
      if (property === 'getThinkingLevel') return () => expected.thinking;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  fusion(wrapped);
  const toolCall = handlers.tool_call;
  if (!toolCall) throw new Error('Fusion worker did not register its tool_call hook.');

  const model = {
    provider: expected.provider,
    id: expected.id,
    reasoning: true,
    thinkingLevelMap: { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  };
  const ctx = {
    modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
    model,
  };
  for (let i = 0; i < 65; i++) {
    const result = await toolCall({ type: 'tool_call', toolCallId: `allowed-${i}`, toolName: 'read', input: {} }, ctx);
    if (result?.block) throw new Error(`Allowlisted tool call ${i + 1} was blocked: ${result.reason}`);
  }
  for (const toolName of ['fusion_sidekick', 'powershell']) {
    const result = await toolCall({ type: 'tool_call', toolCallId: toolName, toolName, input: {} }, ctx);
    if (!result?.block || result.terminate !== true || !result.reason.includes('non-allowlisted tools')) {
      throw new Error(`Non-allowlisted tool was not blocked and terminated: ${toolName}`);
    }
  }
  writeFileSync(process.env.PI_FUSION_HOOK_TEST_RESULT!, 'ok');
}
