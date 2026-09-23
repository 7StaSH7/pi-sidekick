import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fusionConfigPath, loadFusionConfig, saveFusionConfig } from '../config.mjs';
import { DEFAULT_FUSION_CONFIG, DEFAULT_TIMEOUT_MINUTES } from '../policy.mjs';

test('fusion config defaults, saves atomically and reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fusion-config-'));
  try {
    assert.deepEqual(loadFusionConfig(dir), DEFAULT_FUSION_CONFIG);
    const sidekick = { provider: 'openai', id: 'alternate', thinking: 'high' };
    const saved = saveFusionConfig(dir, { sidekick });
    assert.deepEqual(saved, { sidekick, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES });
    assert.deepEqual(loadFusionConfig(dir), saved);
    assert.doesNotMatch(readFileSync(fusionConfigPath(dir), 'utf8'), /animation/);
    writeFileSync(fusionConfigPath(dir), JSON.stringify({ sidekick }));
    assert.deepEqual(loadFusionConfig(dir), saved, 'missing timeout migrates to the default');
    writeFileSync(fusionConfigPath(dir), JSON.stringify({ ...saved, animation: false }));
    assert.deepEqual(loadFusionConfig(dir), saved, 'legacy animation=false is ignored');
    saveFusionConfig(dir, loadFusionConfig(dir));
    assert.deepEqual(JSON.parse(readFileSync(fusionConfigPath(dir), 'utf8')), saved);
    assert.doesNotMatch(readFileSync(fusionConfigPath(dir), 'utf8'), /animation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round-trips a nonpreset timeout and rejects invalid config files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fusion-timeout-config-'));
  try {
    const sidekick = { provider: 'openai', id: 'alternate', thinking: 'high' };
    const saved = saveFusionConfig(dir, { sidekick, timeoutMinutes: 90 });
    assert.deepEqual(saved, { sidekick, timeoutMinutes: 90 });
    assert.deepEqual(loadFusionConfig(dir), saved);
    for (const timeoutMinutes of [0, -1, 1.5, '90', Number.NaN, Number.POSITIVE_INFINITY]) {
      writeFileSync(fusionConfigPath(dir), JSON.stringify({ sidekick, timeoutMinutes: typeof timeoutMinutes === 'number' && !Number.isFinite(timeoutMinutes) ? null : timeoutMinutes }));
      assert.throws(() => loadFusionConfig(dir), /timeoutMinutes/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid existing fusion config fails instead of falling back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fusion-invalid-config-'));
  try {
    saveFusionConfig(dir, { sidekick: { provider: 'openai', id: 'alternate', thinking: 'high' } });
    const file = fusionConfigPath(dir);
    writeFileSync(file, JSON.stringify({ sidekick: { provider: 'openai', id: 'missing', thinking: 'max' }, unexpected: 1 }));
    assert.throws(() => loadFusionConfig(dir), /Invalid Fusion config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
