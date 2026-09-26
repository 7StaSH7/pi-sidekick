import test from 'node:test';
import assert from 'node:assert/strict';
import { activityDuration, applyActivityEvent, BRAILLE_FRAMES, createActivityState, formatActivity, formatActivityActions, formatDuration, FRAME_INTERVAL_MS, resetActivity, startActivityAnimation } from '../activity.mjs';

const start = (toolCallId, toolName, args, now) => applyActivityEvent(activity, { type: 'tool_execution_start', toolCallId, toolName, args }, now);
const end = (toolCallId, toolName, isError, now) => applyActivityEvent(activity, { type: 'tool_execution_end', toolCallId, toolName, isError }, now);
let activity;

test('formats paths, ranges, queries, commands and tool failures', () => {
  activity = createActivityState();
  start('read-1', 'read', { path: 'apps/flutter/lib/training_page.dart', line_start: 800, line_end: 894 }, 1000);
  assert.match(formatActivity(activity), /▶ read apps\/flutter\/lib\/training_page\.dart:800–894/);
  end('read-1', 'read', false, 1120);
  start('grep-1', 'grep', { pattern: 'exercise_card', path: 'apps\/flutter' }, 1200);
  end('grep-1', 'grep', false, 1300);
  start('bash-1', 'bash', { command: 'flutter test test/exercise_test.dart' }, 1400);
  end('bash-1', 'bash', true, 3400);
  const output = formatActivity(activity);
  assert.match(output, /✓ read apps\/flutter\/lib\/training_page\.dart:800–894 · 120ms/);
  assert.match(output, /✓ grep exercise_card in apps\/flutter/);
  assert.match(output, /✗ bash flutter test test\/exercise_test\.dart · 2s/);
});

test('keeps parallel tool ids separate and bounds recent history', () => {
  activity = createActivityState();
  start('parallel-a', 'read', { path: 'a.dart' }, 0);
  start('parallel-b', 'read', { path: 'b.dart' }, 0);
  end('parallel-b', 'read', true, 40);
  end('parallel-a', 'read', false, 50);
  assert.match(formatActivity(activity), /✓ read a\.dart · 50ms/);
  assert.match(formatActivity(activity), /✗ read b\.dart · 40ms/);

  for (let index = 1; index <= 6; index += 1) {
    start(`id-${index}`, 'read', { path: `file-${index}.dart` }, index * 100);
    end(`id-${index}`, 'read', false, index * 100 + 10);
  }
  assert.equal(activity.actions.length, 5);
  assert.equal(activity.history.length, 8);
  assert.equal(formatActivityActions(activity.history).split('\n').length, 8);
  assert.equal(activity.completed, 8);
  const output = formatActivity(activity);
  assert.doesNotMatch(output, /file-1\.dart/);
  assert.match(output, /file-6\.dart/);
  assert.equal(output.split('\n').length, 7);
});

test('resets per task and hides control characters, secrets and write bodies', () => {
  activity = createActivityState();
  start('write-1', 'write', { path: '\u001b[31mnotes\n.txt', content: 'PRIVATE_WRITE_BODY' }, 0);
  start('bash-1', 'bash', { command: 'curl https://example.test -H "Authorization: Bearer super-secret-token"' }, 1);
  const output = formatActivity(activity);
  assert.match(output, /write notes \.txt/);
  assert.doesNotMatch(output, /PRIVATE_WRITE_BODY|super-secret-token|\u001b|\n\.txt/);
  assert.match(output, /bash \[command hidden: possible secret\]/);

  resetActivity(activity);
  assert.match(formatActivity(activity), /^⠋ Working · \d+ms\nsidekick · starting · completed: 0$/);
  assert.equal(activity.actions.length, 0);
});

test('elapsed time is monotonic and appears alongside the full action count', () => {
  activity = createActivityState('sidekick', 1000);
  start('read-1', 'read', { path: 'file.txt' }, 100);
  end('read-1', 'read', false, 150);
  assert.equal(activityDuration(activity, 2250), 1250);
  assert.equal(formatDuration(119999), '1m 59s');
  assert.match(formatActivity(activity, 1, 2250), /^⠙ Working · 1\.3s\nsidekick · waiting for model · completed: 1/);
});

test('Working braille heartbeat cycles and stops on abort or cleanup', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const frames = [];
  const controller = new AbortController();
  const stop = startActivityAnimation(frame => frames.push(frame), controller.signal);
  t.mock.timers.tick(FRAME_INTERVAL_MS);
  t.mock.timers.tick(FRAME_INTERVAL_MS);
  assert.deepEqual(frames, [1, 2]);
  const state = createActivityState();
  assert.ok(formatActivity(state, frames[0]).startsWith(BRAILLE_FRAMES[1]));
  assert.ok(formatActivity(state, BRAILLE_FRAMES.length).startsWith(BRAILLE_FRAMES[0]));
  controller.abort();
  t.mock.timers.tick(FRAME_INTERVAL_MS * 5);
  assert.deepEqual(frames, [1, 2]);
  stop();
  const cleanup = startActivityAnimation(() => frames.push('leak'));
  cleanup();
  t.mock.timers.tick(FRAME_INTERVAL_MS * 5);
  assert.deepEqual(frames, [1, 2]);
  assert.ok(!formatActivity(state).includes('▰'));
});

test('agent_end is not final until agent_settled', () => {
  const state = createActivityState('sidekick');
  applyActivityEvent(state, { type: 'agent_end', willRetry: false });
  assert.match(formatActivity(state), /waiting to settle/);
  assert.doesNotMatch(formatActivity(state), /ready/);
  applyActivityEvent(state, { type: 'agent_settled' });
  assert.match(formatActivity(state), /ready/);
});
