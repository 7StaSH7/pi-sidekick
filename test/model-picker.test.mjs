import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createModelPicker } from '../model-picker.mjs';

const require = createRequire(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
const { Input, Key, SelectList, Text, matchesKey, truncateToWidth, visibleWidth } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
const keys = { down: '\u001b[B', enter: '\r', escape: '\u001b' };
assert(matchesKey(keys.down, Key.down));
assert(matchesKey(keys.enter, Key.enter));
assert(matchesKey(keys.escape, Key.escape));
const theme = { fg: (_color, text) => text };
const models = [
  { provider: 'anthropic', id: 'claude-alpha', name: 'Claude Friendly', cost: { input: 0.12, cacheRead: 0.02, output: 0.6 } },
  { provider: 'openai-codex', id: 'current-model', name: 'Current Choice', cost: { input: 0, cacheRead: Infinity } },
  { provider: 'custom-provider', id: 'suffix-find-me', name: 'Cobalt Local' },
];

function createPicker(currentIndex = 1, signal) {
  let result = Symbol('not selected');
  let doneCount = 0;
  const tui = { requestRender() {} };
  const factory = createModelPicker(models, currentIndex, signal, { Input, SelectList, Text, truncateToWidth });
  const component = factory(tui, theme, {}, value => { result = value; doneCount++; });
  return { component, result: () => result, doneCount: () => doneCount };
}

function type(component, value) {
  for (const character of value) component.handleInput(character);
}

test('model picker starts at the current model, navigates with native keys, and shows truthful API rates', () => {
  const picker = createPicker();
  const initial = picker.component.render(120).join('\n');
  assert.match(initial, /→ openai-codex\/current-model.*\(Current\)/);
  assert.match(initial, /API rates \(USD\/1M tokens\): input \$0\.00 · cache-read unavailable · output\s*unavailable/);
  assert.doesNotMatch(initial, /free/i);

  picker.component.handleInput(keys.down);
  assert.match(picker.component.render(120).join('\n'), /→ custom-provider\/suffix-find-me/);
  picker.component.handleInput(keys.enter);
  assert.equal(picker.result(), 2);
});

test('model picker filters provider, model-id substrings, and names case-insensitively', () => {
  for (const [query, expectedIndex] of [['ANTHROPIC', 0], ['suffix-find', 2], ['cObAlT lOcAl', 2]]) {
    const picker = createPicker();
    type(picker.component, query);
    const rendered = picker.component.render(120).join('\n');
    assert.match(rendered, /→ /);
    assert.equal(rendered.includes(models[expectedIndex].id), true, query);
    if (expectedIndex === 2) {
      assert.match(rendered, /API rates \(USD\/1M tokens\): input unavailable · cache-read unavailable · output\s*unavailable/);
    }
    for (const [index, model] of models.entries()) {
      if (index !== expectedIndex) assert.equal(rendered.includes(model.id), false, `${query} included ${model.id}`);
    }
    picker.component.handleInput(keys.enter);
    assert.equal(picker.result(), expectedIndex);
  }
});

test('no-results Enter cannot choose a stale model; Escape cancels', () => {
  const picker = createPicker();
  type(picker.component, 'no-such-model');
  const rendered = picker.component.render(80).join('\n');
  assert.match(rendered, /No matching models/);
  assert.match(rendered, /No model selected · API USD\/1M token prices unavailable/);

  picker.component.handleInput(keys.enter);
  assert.equal(typeof picker.result(), 'symbol');
  picker.component.handleInput(keys.escape);
  assert.equal(picker.result(), null);
});

test('signal abort resolves the picker once and removes its listener', () => {
  let aborted = false;
  const listeners = new Set();
  const signal = {
    get aborted() { return aborted; },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  const picker = createPicker(1, signal);
  assert.equal(listeners.size, 1);
  aborted = true;
  for (const listener of [...listeners]) listener();
  assert.equal(picker.result(), null);
  assert.equal(picker.doneCount(), 1);
  assert.equal(listeners.size, 0);
  picker.component.dispose();
  assert.equal(picker.doneCount(), 1);
});

test('disposing an unfinished picker cancels and removes its abort listener', () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  const picker = createPicker(1, signal);
  picker.component.dispose();
  assert.equal(picker.result(), null);
  assert.equal(picker.doneCount(), 1);
  assert.equal(listeners.size, 0);
});

test('model picker bounds the visible list to eight rows', () => {
  const manyModels = Array.from({ length: 12 }, (_, index) => ({
    provider: 'provider', id: `model-${index}`, name: `Model ${index}`, cost: {},
  }));
  const component = createModelPicker(manyModels, 0, undefined, { Input, SelectList, Text, truncateToWidth })(
    { requestRender() {} }, theme, {}, () => {},
  );
  const rendered = component.render(80).join('\n');
  assert(rendered.includes('(1/12)'));
  assert.equal(manyModels.filter(model => rendered.includes(model.id)).length, 8);
});

test('model picker stays within narrow and wide terminal widths', () => {
  const longModel = {
    provider: 'provider-name-'.repeat(10),
    id: 'model-identifier-'.repeat(10),
    name: 'A long human-readable model name '.repeat(8),
    cost: { input: 0.0000002, cacheRead: 0, output: 1.25 },
  };
  const picker = createModelPicker([longModel], 0, undefined, { Input, SelectList, Text, truncateToWidth })(
    { requestRender() {} }, theme, {}, () => {},
  );
  assert.match(picker.render(120).join('\n'), /input \$0\.0000002 ·\s*cache-read \$0\.00 · output \$1\.25/);
  for (const width of [1, 8, 20, 40, 80, 120]) {
    for (const line of picker.render(width)) {
      assert(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
    }
  }
});
