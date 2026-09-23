import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { callText, resultText } from '../presentation.mjs';
import { createActivityState, formatActivity, applyActivityEvent } from '../activity.mjs';

const theme = {
  fg: (color, text) => `\x1b[${({ accent: 36, muted: 37, dim: 90, success: 32, error: 31 })[color] ?? 37}m${text}\x1b[0m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
};
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '');

test('Pi-style progress is themed, wraps safely, and completed results stop showing Working', async () => {
  const require = createRequire(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
  const { Text, visibleWidth } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
  const state = createActivityState('openai-codex/gpt-5.6-luna · max');
  applyActivityEvent(state, { type: 'tool_execution_start', toolCallId: 'read', toolName: 'read', args: { path: 'src/' + 'long-path/'.repeat(15) + 'file.ts' } }, 0);
  const partial = resultText({ content: [{ type: 'text', text: formatActivity(state, 1) }] }, { isPartial: true }, theme);
  assert(partial.startsWith('\x1b[36m⠙\x1b[0m'));
  assert(strip(partial).startsWith('⠙ Working\n'));
  const args = { brief: 'Refactor the file', constraints: 'Keep public API', success_criteria: 'Tests pass' };
  const collapsedCall = callText(args, false, theme);
  const expandedCall = callText(args, true, theme);
  assert(collapsedCall.includes('Sidekick'));
  assert(!collapsedCall.includes('Keep public API'));
  assert(expandedCall.includes('Keep public API'));
  assert(expandedCall.includes('Tests pass'));
  const report = Array.from({ length: 8 }, (_, i) => `Report line ${i}`).join('\n');
  const result = { content: [{ type: 'text', text: report }] };
  const collapsed = resultText(result, {}, theme);
  const expanded = resultText(result, { expanded: true }, theme);
  const error = resultText(result, { isError: true }, theme);
  assert(strip(collapsed).startsWith('✓ Complete'));
  assert(collapsed.includes('Expand for the full report'));
  assert(!collapsed.includes('Report line 7'));
  assert(expanded.includes('Report line 7'));
  assert(error.includes('Report line 7'));
  assert(!error.includes('✓ Complete'));
  assert(!expanded.includes('Working'));
  for (const text of [partial, collapsedCall, expandedCall, collapsed, expanded, error]) {
    for (const width of [1, 20, 40, 80, 120]) {
      for (const line of new Text(text, 0, 0).render(width)) assert(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
    }
  }
});
