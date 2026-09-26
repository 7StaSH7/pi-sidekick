import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatStats, makeDelegationRecord } from '../cost.mjs';
import { LEGACY_STATS, STATS } from '../policy.mjs';
import { readSessionStats, readTaskTranscript } from '../history.mjs';

const lead = { provider: 'anthropic', id: 'lead', rates: { input: 4, output: 12, cacheRead: 1, cacheWrite: 4 } };
const sidekick = { provider: 'openai-codex', id: 'worker', rates: { input: 1, output: 3, cacheRead: 0.25, cacheWrite: 1 } };
const record = (callId, durationMs, outcome = 'success') => makeDelegationRecord(callId, lead, sidekick, { input: 10 }, outcome, durationMs);
const statsEntry = (id, data, legacy = false) => ({
  type: 'custom', id: `entry-${id}`, parentId: null,
  customType: legacy ? LEGACY_STATS : STATS, data,
});
const session = (...entries) => [JSON.stringify({ type: 'session', version: 3, id: 'session', cwd: '/project' }), ...entries.map(JSON.stringify)].join('\n') + '\n';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sidekick-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('read-only stats stream multiple session files, dedupe fork copies and include unsaved current entries', async t => {
  const dir = temp(t);
  const currentDir = join(dir, 'custom-current-dir');
  mkdirSync(currentDir);
  const old = record('old-call', undefined);
  const recent = record('recent-call', 1270, 'error');
  const memory = record('memory-call', 2300);
  const oldFile = join(dir, 'old.jsonl');
  const currentFile = join(currentDir, 'current.jsonl');
  const forkCopy = join(dir, 'fork-copy.jsonl');
  writeFileSync(oldFile, session(statsEntry('old', old, true)));
  writeFileSync(currentFile, session(statsEntry('recent', recent)));
  writeFileSync(forkCopy, readFileSync(currentFile));
  const before = [oldFile, currentFile, forkCopy].map(path => readFileSync(path));

  const result = await readSessionStats({
    sessionPaths: [oldFile, currentFile, forkCopy, currentFile],
    currentFile,
    currentEntries: [statsEntry('memory', memory)],
  });
  assert.deepEqual(result.records.map(item => item.callId).sort(), ['memory-call', 'old-call', 'recent-call']);
  assert.equal(result.records.find(item => item.callId === 'old-call').durationMs, undefined);
  assert.equal(result.records.find(item => item.callId === 'recent-call').durationMs, 1270);
  assert.equal(result.malformedLines, 0);
  assert.equal(result.unreadableFiles, 0);
  assert.match(formatStats(result.records), /Duration: 3\.6s · 2 known · 1 unknown/);
  assert.deepEqual([oldFile, currentFile, forkCopy].map(path => readFileSync(path)), before);
});

test('stats report malformed lines and unreadable files even with zero valid records', async t => {
  const dir = temp(t);
  const malformed = join(dir, 'malformed.jsonl');
  const missing = join(dir, 'missing.jsonl');
  writeFileSync(malformed, `${session().trimEnd()}\nnot-json\n`);
  const before = readFileSync(malformed);
  const result = await readSessionStats({ sessionPaths: [malformed, missing] });
  assert.deepEqual(result.records, []);
  assert.equal(result.malformedLines, 1);
  assert.equal(result.unreadableFiles, 1);
  const report = formatStats(result.records, {
    scope: 'all sessions', malformedLines: result.malformedLines, unreadableFiles: result.unreadableFiles,
  });
  assert.match(report, /No delegated Sidekick cost history in all sessions/);
  assert.match(report, /1 malformed JSONL line/);
  assert.match(report, /1 unreadable file/);
  assert.match(report, /totals may be incomplete/);
  assert.deepEqual(readFileSync(malformed), before);
});

test('stats preserve partial records with warnings and propagate cancellation', async t => {
  const dir = temp(t);
  const path = join(dir, 'partial.jsonl');
  writeFileSync(path, `${session(statsEntry('partial', record('partial-call', 500))).trimEnd()}\n{bad\n`);
  const before = readFileSync(path);
  const result = await readSessionStats({ sessionPaths: [path] });
  assert.equal(result.records.length, 1);
  assert.equal(result.malformedLines, 1);
  assert.match(formatStats(result.records, { malformedLines: result.malformedLines }), /saved-history totals may be incomplete/);
  assert.deepEqual(readFileSync(path), before);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readSessionStats({ sessionPaths: [path], signal: controller.signal }), { name: 'AbortError' });
});

test('read-only transcript follows exact task boundaries, including explicit root, without rewriting JSONL', t => {
  const dir = temp(t);
  const roots = [join(dir, 'agent', 'sidekick', 'sessions'), join(dir, 'agent', 'fusion', 'sessions')];
  for (const root of roots) mkdirSync(root, { recursive: true });
  const file = join(roots[0], 'worker.jsonl');
  const entries = [
    { type: 'session', version: 3, id: 'worker', cwd: '/project' },
    { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'PREVIOUS TASK' } },
    { type: 'message', id: 'end-one', parentId: 'root', message: { role: 'assistant', content: [{ type: 'text', text: 'PREVIOUS REPORT' }] } },
    { type: 'message', id: 'start-two', parentId: 'end-one', message: { role: 'user', content: 'CURRENT TASK' } },
    { type: 'message', id: 'end-two', parentId: 'start-two', message: { role: 'assistant', content: [{ type: 'text', text: 'CURRENT REPORT' }] } },
    { type: 'message', id: 'later', parentId: 'end-two', message: { role: 'user', content: 'LATER TASK' } },
  ];
  writeFileSync(file, entries.map(JSON.stringify).join('\n') + '\n');
  const before = readFileSync(file);
  const prior = readTaskTranscript({ sessionFile: file, fromEntryId: null, toEntryId: 'end-one' }, roots);
  const current = readTaskTranscript({ sessionFile: file, fromEntryId: 'end-one', toEntryId: 'end-two' }, roots);
  assert.match(prior, /PREVIOUS TASK|PREVIOUS REPORT/);
  assert.doesNotMatch(prior, /CURRENT TASK|LATER TASK/);
  assert.match(current, /CURRENT TASK|CURRENT REPORT/);
  assert.doesNotMatch(current, /PREVIOUS TASK|PREVIOUS REPORT|LATER TASK/);
  assert.deepEqual(readFileSync(file), before);
});

test('transcript reader rejects outside paths, escaping symlinks, missing and corrupt files', t => {
  const dir = temp(t);
  const root = join(dir, 'agent', 'sidekick', 'sessions');
  mkdirSync(root, { recursive: true });
  const outside = join(dir, 'outside.jsonl');
  writeFileSync(outside, session());
  const outsideBefore = readFileSync(outside);
  const escaped = join(root, 'escaped.jsonl');
  symlinkSync(outside, escaped);
  const broken = join(root, 'broken.jsonl');
  writeFileSync(broken, '{broken json\n');
  const brokenBefore = readFileSync(broken);
  const roots = [root];
  const ref = sessionFile => ({ sessionFile, fromEntryId: null, toEntryId: 'end' });
  assert.throws(() => readTaskTranscript(ref(outside), roots), /outside/);
  assert.throws(() => readTaskTranscript(ref(escaped), roots), /symlink escapes/);
  assert.throws(() => readTaskTranscript(ref(join(root, 'missing.jsonl')), roots), /missing or unreadable/);
  assert.throws(() => readTaskTranscript(ref(broken), roots), /malformed line/);
  assert.deepEqual(readFileSync(outside), outsideBefore);
  assert.deepEqual(readFileSync(broken), brokenBefore);
  assert.equal(existsSync(escaped), true);
});

test('transcript reader rejects missing parents, cycles and reversed task boundaries', t => {
  const dir = temp(t);
  const root = join(dir, 'sessions');
  mkdirSync(root);
  const file = join(root, 'chains.jsonl');
  const writeEntries = entries => writeFileSync(file, entries.map(JSON.stringify).join('\n') + '\n');
  const ref = (fromEntryId, toEntryId) => ({ sessionFile: file, fromEntryId, toEntryId });
  writeEntries([
    { type: 'session', id: 's' },
    { type: 'message', id: 'end', parentId: 'missing', message: { role: 'assistant', content: [] } },
  ]);
  assert.throws(() => readTaskTranscript(ref(null, 'end'), [root]), /missing parent/);
  writeEntries([
    { type: 'message', id: 'a', parentId: 'b', message: { role: 'user', content: 'a' } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [] } },
  ]);
  assert.throws(() => readTaskTranscript(ref(null, 'a'), [root]), /cycle/);
  writeEntries([
    { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'root' } },
    { type: 'message', id: 'end', parentId: 'root', message: { role: 'assistant', content: [] } },
    { type: 'message', id: 'start-later', parentId: 'end', message: { role: 'user', content: 'later' } },
  ]);
  assert.throws(() => readTaskTranscript(ref('start-later', 'end'), [root]), /not earlier/);
  assert.throws(() => readTaskTranscript(ref('absent', 'end'), [root]), /not earlier/);
});

test('expanded transcript is not capped at the model-facing 50 KB report limit', t => {
  const dir = temp(t);
  const root = join(dir, 'sessions');
  mkdirSync(root);
  const file = join(root, 'large.jsonl');
  const fullReport = `${'report text '.repeat(5000)}FULL_REPORT_AFTER_50KB`;
  writeFileSync(file, [
    JSON.stringify({ type: 'session', id: 's' }),
    JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'brief' } }),
    JSON.stringify({ type: 'message', id: 'end', parentId: 'root', message: { role: 'assistant', content: [{ type: 'text', text: fullReport }] } }),
  ].join('\n') + '\n');
  const transcript = readTaskTranscript({ sessionFile: file, fromEntryId: null, toEntryId: 'end' }, [root]);
  assert(transcript.length > 50 * 1024);
  assert.match(transcript, /FULL_REPORT_AFTER_50KB$/);
});
