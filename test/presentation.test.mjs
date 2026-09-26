import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { callText, formatTaskTranscript, formatTranscript, resultText } from '../presentation.mjs';
import { makeDelegationRecord } from '../cost.mjs';
import { createActivityState, formatActivity, applyActivityEvent } from '../activity.mjs';

const theme = {
  fg: (color, text) => `\x1b[${({ accent: 36, muted: 37, dim: 90, success: 32, error: 31 })[color] ?? 37}m${text}\x1b[0m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
};
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '');

test('expanded results show only the task transcript, excluding system prompts and hidden thinking', () => {
  const transcript = formatTranscript([
    { type: 'message', message: { role: 'system', content: [{ type: 'text', text: 'PRIVATE_SYSTEM_PROMPT' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Read this file' }] } },
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'PRIVATE_THINKING' },
      { type: 'text', text: 'I will inspect it.' },
      { type: 'toolCall', name: 'read', arguments: { path: 'file.txt' } },
    ] } },
    { type: 'message', message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: '\u001b[31mfile contents\u001b[0m' }] } },
    { type: 'compaction', summary: 'Keep the file contents in context.' },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Final report.' }] } },
  ]);
  assert.match(transcript, /Tool call · read\nArguments\n\{\n  "path": "file\.txt"/);
  assert.match(transcript, /Tool result · read\nfile contents/);
  assert.match(transcript, /Compaction summary/);
  assert.match(transcript, /Final report/);
  assert.doesNotMatch(transcript, /PRIVATE_SYSTEM_PROMPT|PRIVATE_THINKING/);
  assert.equal(transcript.includes('\u001b'), false);
  const branch = [
    { id: 'prior', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'OLD TASK' }] } },
    { id: 'start', type: 'custom', customType: 'checkpoint' },
    { id: 'task', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'CURRENT TASK' }] } },
    { id: 'end', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'CURRENT REPORT' }] } },
    { id: 'later', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'LATER TASK' }] } },
  ];
  const savedTask = formatTaskTranscript(branch, 'start', 'end');
  assert.match(savedTask, /CURRENT TASK|CURRENT REPORT/);
  assert.doesNotMatch(savedTask, /OLD TASK|LATER TASK/);
  assert.equal(formatTaskTranscript(branch, 'missing', 'end'), undefined);

  const result = { content: [{ type: 'text', text: 'Worker failed.\nline 2\nline 3\nline 4\nline 5\nline 6' }], details: { durationMs: 1520, actionCount: 3 } };
  const collapsed = resultText(result, { expanded: false, isPartial: false, isError: false, expandHint: 'Ctrl+O to expand' }, theme);
  const expanded = resultText(result, { expanded: true, isPartial: false, isError: false, transcriptText: transcript }, theme);
  const failed = resultText(result, { expanded: false, isPartial: false, isError: true }, theme);
  assert.match(strip(collapsed), /Complete · 1\.5s · 3 actions/);
  assert.match(collapsed, /Ctrl\+O to expand/);
  assert.match(expanded, /Final report/);
  assert.match(strip(failed), /Failed · 1\.5s · 3 actions/);
  assert.match(failed, /Worker failed/);
  assert.match(failed, /to expand/);
  const expandedFailure = resultText(result, {
    expanded: true, isError: true, transcriptText: transcript,
  }, theme);
  assert.match(strip(expandedFailure), /Tool call · read/);
  assert.match(strip(expandedFailure), /Error\nWorker failed\./);
  const cancelled = resultText({ ...result, details: { ...result.details, costRecord: { outcome: 'cancelled' } } }, { expanded: false, isPartial: false, isError: true }, theme);
  assert.match(strip(cancelled), /Cancelled · 1\.5s · 3 actions/);

  const unavailableSuccess = resultText({
    content: [{ type: 'text', text: 'Task report.\n\nEstimated cost comparison unavailable (missing price).' }],
  }, { expanded: true, transcriptError: 'Transcript file is missing.', isError: false }, theme);
  assert.match(strip(unavailableSuccess), /transcript unavailable: Transcript file is missing/);
  assert.match(strip(unavailableSuccess), /Task report\./);
  assert.doesNotMatch(strip(unavailableSuccess), /Estimated cost comparison unavailable/);
  const unavailableError = resultText({ content: [{ type: 'text', text: 'Worker error details.' }] }, {
    expanded: true, transcriptError: 'Transcript chain is broken.', isError: true,
  }, theme);
  assert.match(strip(unavailableError), /transcript unavailable: Transcript chain is broken/);
  assert.match(strip(unavailableError), /Worker error details\./);

  const oldResult = resultText({ content: [{ type: 'text', text: 'Old report.\n\nEstimated delegated cost: $0.02\n\nSidekick session: old.jsonl' }] }, {}, theme);
  assert.match(strip(oldResult), /Old report\./);
  assert.doesNotMatch(strip(oldResult), /Estimated delegated cost|Sidekick session/);
  const fullTranscript = `Sidekick\n${'report '.repeat(8000)}FULL_REPORT_AFTER_50KB`;
  const expandedLarge = resultText({ content: [{ type: 'text', text: `${'report '.repeat(6000)}\n[Report truncated.]` }] }, {
    expanded: true, transcriptText: fullTranscript, isError: false,
  }, theme);
  assert(expandedLarge.length > 50 * 1024);
  assert.match(expandedLarge, /FULL_REPORT_AFTER_50KB/);
  assert.doesNotMatch(expandedLarge, /Report truncated/);

  const actions = Array.from({ length: 7 }, (_, index) => ({ label: `read file-${index}.txt`, status: 'success', durationMs: 10 }));
  const progress = { content: [{ type: 'text', text: '⠋ Working · 2s\nsidekick · executing actions · completed: 7\n✓ read recent.txt · 10ms' }], details: { actions } };
  const expandedProgress = resultText(progress, { expanded: true, isPartial: true, isError: false }, theme);
  const compactProgress = resultText(progress, { expanded: false, isPartial: true, isError: false }, theme);
  assert.match(expandedProgress, /read file-0\.txt/);
  assert.match(expandedProgress, /read file-6\.txt/);
  assert.doesNotMatch(compactProgress, /read file-0\.txt/);
});

test('Pi-style progress is themed, wraps safely, and completed results stop showing Working', async () => {
  const require = createRequire(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
  const { Text, visibleWidth } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
  const state = createActivityState('openai-codex/gpt-5.6-luna · max');
  applyActivityEvent(state, { type: 'tool_execution_start', toolCallId: 'read', toolName: 'read', args: { path: 'src/' + 'long-path/'.repeat(15) + 'file.ts' } }, 0);
  const partial = resultText({ content: [{ type: 'text', text: formatActivity(state, 1) }] }, { isPartial: true }, theme);
  assert(partial.startsWith('\x1b[36m⠙\x1b[0m'));
  assert(strip(partial).startsWith('⠙ Working · '));
  const args = { brief: 'Refactor the file', constraints: 'Keep public API', success_criteria: 'Tests pass' };
  const collapsedCall = callText(args, false, theme);
  const expandedCall = callText(args, true, theme);
  assert(collapsedCall.includes('Sidekick'));
  assert(!collapsedCall.includes('Keep public API'));
  assert(expandedCall.includes('Keep public API'));
  assert(expandedCall.includes('Tests pass'));
  const report = Array.from({ length: 8 }, (_, i) => `Report line ${i}`).join('\n');
  const rates = { input: 4, output: 12, cacheRead: 1, cacheWrite: 4 };
  const costRecord = makeDelegationRecord('display', { provider: 'anthropic', id: 'lead', rates }, {
    provider: 'openai-codex', id: 'sidekick', rates: { input: 1, output: 3, cacheRead: 0.25, cacheWrite: 1 },
  }, { input: 1_000_000 }, 'success', 3210);
  const result = { content: [{ type: 'text', text: report }], details: { costRecord } };
  const collapsed = resultText(result, {}, theme);
  const expanded = resultText(result, { expanded: true }, theme);
  const error = resultText(result, { isError: true }, theme);
  assert(strip(collapsed).startsWith('✓ Complete'));
  assert(collapsed.includes('to expand'));
  assert(!collapsed.includes('Report line 7'));
  assert(expanded.includes('Report line 7'));
  assert(error.includes('Report line 7'));
  assert(!error.includes('✓ Complete'));
  assert(!expanded.includes('Working'));
  assert.match(strip(collapsed), /Sidekick \$1\.00 · Lead equivalent \$4\.00/);
  assert.match(strip(collapsed), /≈ Saved/);
  assert.match(strip(expanded), /Subscription billing is not represented/);
  assert.match(strip(expanded), /Excludes lead planning\/review/);
  for (const text of [partial, collapsedCall, expandedCall, collapsed, expanded, error]) {
    for (const width of [1, 20, 40, 80, 120]) {
      for (const line of new Text(text, 0, 0).render(width)) assert(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
    }
  }
});
