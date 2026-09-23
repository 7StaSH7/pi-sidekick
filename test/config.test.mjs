import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sidekickConfigPath, loadSidekickConfig, saveSidekickConfig } from '../config.mjs';
import { DEFAULT_SIDEKICK_CONFIG, DEFAULT_TIMEOUT_MINUTES } from '../policy.mjs';

test('Sidekick config defaults, saves atomically and reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sidekick-config-'));
  try {
    assert.deepEqual(loadSidekickConfig(dir), DEFAULT_SIDEKICK_CONFIG);
    const sidekick = { provider: 'openai', id: 'alternate', thinking: 'high' };
    const saved = saveSidekickConfig(dir, { sidekick });
    assert.deepEqual(saved, { sidekick, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES });
    assert.deepEqual(loadSidekickConfig(dir), saved);
    assert.doesNotMatch(readFileSync(sidekickConfigPath(dir), 'utf8'), /animation/);
    writeFileSync(sidekickConfigPath(dir), JSON.stringify({ sidekick }));
    assert.deepEqual(loadSidekickConfig(dir), saved, 'missing timeout migrates to the default');
    writeFileSync(sidekickConfigPath(dir), JSON.stringify({ ...saved, animation: false }));
    assert.deepEqual(loadSidekickConfig(dir), saved, 'legacy animation=false is ignored');
    saveSidekickConfig(dir, loadSidekickConfig(dir));
    assert.deepEqual(JSON.parse(readFileSync(sidekickConfigPath(dir), 'utf8')), saved);
    assert.doesNotMatch(readFileSync(sidekickConfigPath(dir), 'utf8'), /animation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrates legacy config without deleting it and prefers the new file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sidekick-migration-'));
  try {
    const legacy = join(dir, 'fusion.json');
    const oldText = JSON.stringify({ sidekick: { provider: 'openai', id: 'legacy', thinking: 'high' } });
    writeFileSync(legacy, oldText);
    const migrated = loadSidekickConfig(dir);
    assert.deepEqual(migrated, { sidekick: { provider: 'openai', id: 'legacy', thinking: 'high' }, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES });
    assert.deepEqual(JSON.parse(readFileSync(sidekickConfigPath(dir), 'utf8')), migrated);
    assert.equal(readFileSync(legacy, 'utf8'), oldText, 'legacy config must remain untouched');

    const current = { sidekick: { provider: 'openai', id: 'current', thinking: 'medium' }, timeoutMinutes: 90 };
    writeFileSync(sidekickConfigPath(dir), JSON.stringify(current));
    writeFileSync(legacy, JSON.stringify({ sidekick: { provider: 'openai', id: 'older', thinking: 'low' } }));
    assert.deepEqual(loadSidekickConfig(dir), current, 'existing sidekick.json wins');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round-trips a nonpreset timeout and rejects invalid config files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sidekick-timeout-config-'));
  try {
    const sidekick = { provider: 'openai', id: 'alternate', thinking: 'high' };
    const saved = saveSidekickConfig(dir, { sidekick, timeoutMinutes: 90 });
    assert.deepEqual(saved, { sidekick, timeoutMinutes: 90 });
    assert.deepEqual(loadSidekickConfig(dir), saved);
    for (const timeoutMinutes of [0, -1, 1.5, '90', Number.NaN, Number.POSITIVE_INFINITY]) {
      writeFileSync(sidekickConfigPath(dir), JSON.stringify({ sidekick, timeoutMinutes: typeof timeoutMinutes === 'number' && !Number.isFinite(timeoutMinutes) ? null : timeoutMinutes }));
      assert.throws(() => loadSidekickConfig(dir), /timeoutMinutes/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid legacy config is preserved and never replaced with defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sidekick-invalid-legacy-'));
  try {
    const legacy = join(dir, 'fusion.json');
    const oldText = '{"invalid":true}';
    writeFileSync(legacy, oldText);
    assert.throws(() => loadSidekickConfig(dir), /Invalid Sidekick config/);
    assert.equal(readFileSync(legacy, 'utf8'), oldText);
    assert.equal(existsSync(sidekickConfigPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid existing Sidekick config fails instead of falling back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sidekick-invalid-config-'));
  try {
    saveSidekickConfig(dir, { sidekick: { provider: 'openai', id: 'alternate', thinking: 'high' } });
    const file = sidekickConfigPath(dir);
    writeFileSync(join(dir, 'fusion.json'), JSON.stringify({ sidekick: { provider: 'openai', id: 'legacy', thinking: 'high' } }));
    writeFileSync(file, JSON.stringify({ sidekick: { provider: 'openai', id: 'missing', thinking: 'max' }, unexpected: 1 }));
    assert.throws(() => loadSidekickConfig(dir), /Invalid Sidekick config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
