import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SIDEKICK_CONFIG, DEFAULT_TIMEOUT_MINUTES, LEGACY_STATE, LEGACY_STATS, SIDEKICK, STATE, STATS, TOOL, assertModel, requireModel, restoreState, hasSidekickSibling, isStatsEntry, inheritedExtensions, timeoutMilliseconds, validateSidekickConfig, validateSidekickSelection, parseLaunchSidekick } from '../policy.mjs';

test('inherit explicit extension guards and discovery choice, not prompts or credentials', () => {
  assert.deepEqual(inheritedExtensions(['--api-key', 'secret', '-ne', '-e', './guard.ts', '--extension=/abs/check.ts', '-e', 'npm:trusted', '--', '-e', 'not-an-extension'], '/initial'),
    ['--no-extensions', '-e', '/initial/guard.ts', '-e', '/abs/check.ts', '-e', 'npm:trusted']);
});

test('exact configured Sidekick model and reasoning, with no fallback', () => {
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

test('strict Sidekick config, timeout migration and launch snapshot validation', () => {
  assert.deepEqual(validateSidekickConfig(DEFAULT_SIDEKICK_CONFIG), DEFAULT_SIDEKICK_CONFIG);
  const sidekick = { provider: 'openai', id: 'alternate', thinking: 'high' };
  assert.deepEqual(validateSidekickConfig({ sidekick }), { sidekick, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES });
  assert.deepEqual(validateSidekickConfig({ sidekick, animation: false }), { sidekick, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES });
  assert.deepEqual(validateSidekickConfig({ sidekick, timeoutMinutes: 90 }), { sidekick, timeoutMinutes: 90 });
  assert.equal(timeoutMilliseconds(1), 60_000);
  assert.equal(timeoutMilliseconds(1440), 86_400_000);
  for (const timeoutMinutes of [0, -1, 1441, 1.5, '90', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateSidekickConfig({ sidekick, timeoutMinutes }), /timeoutMinutes/);
  }
  assert.deepEqual(validateSidekickSelection(sidekick), sidekick);
  assert.deepEqual(parseLaunchSidekick(JSON.stringify({ provider: 'openai', id: 'alternate', thinking: 'high' })), { provider: 'openai', id: 'alternate', thinking: 'high' });
  assert.throws(() => validateSidekickConfig({ ...DEFAULT_SIDEKICK_CONFIG, extra: true }));
  assert.throws(() => validateSidekickConfig({ sidekick, animation: 'false' }));
  assert.throws(() => validateSidekickConfig({ sidekick, timeoutMinutes: undefined }));
  assert.throws(() => validateSidekickSelection({ provider: 'anthropic', id: 'bad', thinking: 'max' }));
  assert.throws(() => validateSidekickSelection({ provider: 'openai', id: 'bad model', thinking: 'max' }));
  assert.throws(() => parseLaunchSidekick('{"provider":"openai"}'));
});

test('restore latest state marker from active branch, including legacy state, off and reset', () => {
  const checkpoint = { file: '/sessions/luna.jsonl', owner: 'lead-id', leaf: 'leaf-id' };
  const entry = (customType, data) => ({ type: 'custom', customType, data });
  const current = data => entry(STATE, data);
  const legacy = data => entry(LEGACY_STATE, data);
  assert.equal(restoreState([]), undefined);
  assert.deepEqual(restoreState([current({ enabled: true, checkpoint })]), { enabled: true, checkpoint });
  assert.deepEqual(restoreState([current({ enabled: true, checkpoint }), current({ enabled: false })]), { enabled: false });
  assert.deepEqual(restoreState([current({ enabled: true }), legacy({ enabled: false })]), { enabled: false }, 'latest legacy marker wins chronologically');
  assert.deepEqual(restoreState([legacy({ enabled: false }), current({ enabled: true, checkpoint })]), { enabled: true, checkpoint });
  assert.throws(() => restoreState([legacy({ enabled: true, checkpoint: { file: 3 } })]));
  assert.equal(isStatsEntry(entry(STATS, {})), true);
  assert.equal(isStatsEntry(entry(LEGACY_STATS, {})), true);
  assert.equal(isStatsEntry(entry('other-stats', {})), false);
});

test('block lead siblings, including saved calls under the legacy tool name', () => {
  assert.equal(TOOL, 'sidekick');
  const batch = [{ type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', name: 'write' }, { type: 'toolCall', name: TOOL },
  ] } }];
  const legacyBatch = [{ type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', name: 'write' }, { type: 'toolCall', name: 'fusion_sidekick' },
  ] } }];
  assert.equal(hasSidekickSibling(batch, 'write'), true);
  assert.equal(hasSidekickSibling(batch, 'read'), true);
  assert.equal(hasSidekickSibling(batch, TOOL), false);
  assert.equal(hasSidekickSibling(legacyBatch, 'write'), true);
  assert.equal(hasSidekickSibling([], 'write'), false);
  assert.equal(hasSidekickSibling([...batch, { type: 'message', message: { role: 'assistant', content: [] } }], 'write'), false);
});
