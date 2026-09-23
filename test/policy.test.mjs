import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FUSION_CONFIG, DEFAULT_TIMEOUT_MINUTES, SIDEKICK, STATE, TOOL, assertModel, requireModel, restoreState, hasSidekickSibling, inheritedExtensions, timeoutMilliseconds, validateFusionConfig, validateSidekickSelection, parseLaunchSidekick } from '../policy.mjs';

test('inherit explicit extension guards and discovery choice, not prompts or credentials', () => {
  assert.deepEqual(inheritedExtensions(['--api-key', 'secret', '-ne', '-e', './guard.ts', '--extension=/abs/check.ts', '-e', 'npm:trusted', '--', '-e', 'not-an-extension'], '/initial'),
    ['--no-extensions', '-e', '/initial/guard.ts', '-e', '/abs/check.ts', '-e', 'npm:trusted']);
});

test('exact configured sidekick model and reasoning, with no fallback', () => {
  const lead = { provider: 'anthropic', id: 'lead', thinking: 'medium' };
  assert.doesNotThrow(() => assertModel(lead, lead, 'medium'));
  assert.doesNotThrow(() => assertModel(SIDEKICK, SIDEKICK, 'max'));
  for (const model of [undefined, { ...SIDEKICK, provider: 'anthropic' }, { ...SIDEKICK, id: 'gpt-5' }]) {
    assert.throws(() => assertModel(model, SIDEKICK));
  }
  assert.throws(() => assertModel(SIDEKICK, SIDEKICK, 'high'));
  const model = { ...SIDEKICK, reasoning: true, thinkingLevelMap: { max: 'max' } };
  const registry = { find: () => model, hasConfiguredAuth: () => true };
  assert.equal(requireModel(registry, SIDEKICK), model);
  assert.throws(() => requireModel({ ...registry, find: () => undefined }, SIDEKICK), /unavailable/);
  assert.throws(() => requireModel({ ...registry, hasConfiguredAuth: () => false }, SIDEKICK), /authentication/);
  assert.throws(() => requireModel({ ...registry, find: () => ({ ...model, thinkingLevelMap: {} }) }, SIDEKICK), /support reasoning/);
});

test('strict sidekick config, timeout migration and launch snapshot validation', () => {
  assert.deepEqual(validateFusionConfig(DEFAULT_FUSION_CONFIG), DEFAULT_FUSION_CONFIG);
  const sidekick = { provider: 'openai', id: 'alternate', thinking: 'high' };
  assert.deepEqual(validateFusionConfig({ sidekick }), { sidekick, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES });
  assert.deepEqual(validateFusionConfig({ sidekick, animation: false }), { sidekick, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES });
  assert.deepEqual(validateFusionConfig({ sidekick, timeoutMinutes: 90 }), { sidekick, timeoutMinutes: 90 });
  assert.equal(timeoutMilliseconds(1), 60_000);
  assert.equal(timeoutMilliseconds(1440), 86_400_000);
  for (const timeoutMinutes of [0, -1, 1441, 1.5, '90', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateFusionConfig({ sidekick, timeoutMinutes }), /timeoutMinutes/);
  }
  assert.deepEqual(validateSidekickSelection(sidekick), sidekick);
  assert.deepEqual(parseLaunchSidekick(JSON.stringify({ provider: 'openai', id: 'alternate', thinking: 'high' })), { provider: 'openai', id: 'alternate', thinking: 'high' });
  assert.throws(() => validateFusionConfig({ ...DEFAULT_FUSION_CONFIG, extra: true }));
  assert.throws(() => validateFusionConfig({ sidekick, animation: 'false' }));
  assert.throws(() => validateFusionConfig({ sidekick, timeoutMinutes: undefined }));
  assert.throws(() => validateSidekickSelection({ provider: 'anthropic', id: 'bad', thinking: 'max' }));
  assert.throws(() => validateSidekickSelection({ provider: 'openai', id: 'bad model', thinking: 'max' }));
  assert.throws(() => parseLaunchSidekick('{"provider":"openai"}'));
});

test('restore from active branch, including off and reset; reject corrupt state', () => {
  const checkpoint = { file: '/sessions/luna.jsonl', owner: 'lead-id', leaf: 'leaf-id' };
  const entry = data => ({ type: 'custom', customType: STATE, data });
  assert.equal(restoreState([]), undefined);
  assert.deepEqual(restoreState([entry({ enabled: true, checkpoint })]), { enabled: true, checkpoint });
  assert.deepEqual(restoreState([entry({ enabled: true, checkpoint }), entry({ enabled: false })]), { enabled: false });
  assert.throws(() => restoreState([entry({ enabled: true, checkpoint: { file: 3 } })]));
});

test('block lead siblings regardless of execution ordering', () => {
  const batch = [{ type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', name: 'write' }, { type: 'toolCall', name: TOOL },
  ] } }];
  assert.equal(hasSidekickSibling(batch, 'write'), true);
  assert.equal(hasSidekickSibling(batch, 'read'), true);
  assert.equal(hasSidekickSibling(batch, TOOL), false);
  assert.equal(hasSidekickSibling([], 'write'), false);
  assert.equal(hasSidekickSibling([...batch, { type: 'message', message: { role: 'assistant', content: [] } }], 'write'), false);
});
