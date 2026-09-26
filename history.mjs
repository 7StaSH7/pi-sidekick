import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, sep } from 'node:path';
import { dedupeDelegationRecords } from './cost.mjs';
import { isStatsEntry } from './policy.mjs';
import { formatTaskTranscript } from './presentation.mjs';

function inside(root, file) {
  return file.startsWith(root + sep);
}

function entryOf(line) {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.type === 'string'
      ? entry
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readSessionStats({ sessionPaths = [], currentFile, currentEntries = [], signal } = {}) {
  const paths = [...new Set([...sessionPaths, currentFile].filter(path => typeof path === 'string' && path).map(path => resolve(path)))];
  const records = [];
  let malformedLines = 0;
  let unreadableFiles = 0;

  for (const path of paths) {
    signal?.throwIfAborted();
    let stream;
    let lines;
    try {
      stream = createReadStream(path, { encoding: 'utf8', ...(signal ? { signal } : {}) });
      lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        signal?.throwIfAborted();
        if (!line.trim()) continue;
        const entry = entryOf(line);
        if (!entry) {
          malformedLines++;
          continue;
        }
        if (isStatsEntry(entry)) {
          if (!entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data) || typeof entry.data.callId !== 'string' || !entry.data.callId) malformedLines++;
          else records.push(entry.data);
        }
      }
    } catch {
      signal?.throwIfAborted();
      unreadableFiles++;
    } finally {
      lines?.close();
      stream?.destroy();
    }
  }

  signal?.throwIfAborted();
  for (const entry of currentEntries) {
    if (isStatsEntry(entry)) records.push(entry.data);
  }
  return { records: dedupeDelegationRecords(records), malformedLines, unreadableFiles };
}

function existingRoots(roots) {
  return roots.flatMap(root => {
    try {
      const path = resolve(root);
      const real = realpathSync(path);
      return real === path && statSync(real).isDirectory() ? [real] : [];
    } catch {
      return [];
    }
  });
}

function parseTaskEntries(contents) {
  const byId = new Map();
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const entry = entryOf(line);
    if (!entry) throw new Error(`Session history has a malformed line ${index + 1}.`);
    if (entry.type === 'session') continue;
    if (typeof entry.id !== 'string' || !entry.id || !(entry.parentId === null || typeof entry.parentId === 'string')) {
      throw new Error(`Session history has an invalid entry on line ${index + 1}.`);
    }
    if (byId.has(entry.id)) throw new Error('Session history contains duplicate entry ids.');
    byId.set(entry.id, entry);
  }
  return byId;
}

export function readTaskTranscript(reference, roots = []) {
  if (!reference || typeof reference.sessionFile !== 'string' || !reference.sessionFile.endsWith('.jsonl') ||
      typeof reference.toEntryId !== 'string' || !reference.toEntryId ||
      !(reference.fromEntryId === null || typeof reference.fromEntryId === 'string')) {
    throw new Error('Saved transcript reference is invalid or missing.');
  }

  const allowedRoots = existingRoots(roots);
  const requestedPath = resolve(reference.sessionFile);
  const root = allowedRoots.find(path => inside(path, requestedPath));
  if (!root) throw new Error('Transcript path is outside the existing Sidekick session directories.');

  let file;
  try {
    file = realpathSync(requestedPath);
  } catch {
    throw new Error('Transcript file is missing or unreadable.');
  }
  if (!inside(root, file)) throw new Error('Transcript symlink escapes its Sidekick session directory.');
  try {
    if (!statSync(file).isFile()) throw new Error('Transcript path is not a regular file.');
  } catch (error) {
    if (error instanceof Error && error.message === 'Transcript path is not a regular file.') throw error;
    throw new Error('Transcript file is missing or unreadable.');
  }

  let byId;
  try {
    byId = parseTaskEntries(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Session history')) throw error;
    throw new Error('Transcript file is missing or unreadable.');
  }

  const end = byId.get(reference.toEntryId);
  if (!end) throw new Error('Transcript end entry is missing.');
  const reversed = [];
  const seen = new Set();
  let current = end;
  while (current) {
    if (seen.has(current.id)) throw new Error('Transcript entry chain contains a cycle.');
    seen.add(current.id);
    reversed.push(current);
    if (reference.fromEntryId === null ? current.parentId === null : current.id === reference.fromEntryId) break;
    if (current.parentId === null) {
      throw new Error(reference.fromEntryId === null
        ? 'Transcript root entry was not reached.'
        : 'Transcript start entry is not earlier in the end-entry chain.');
    }
    current = byId.get(current.parentId);
    if (!current) throw new Error('Transcript entry chain has a missing parent.');
  }

  if (reference.fromEntryId !== null && reversed.length === 1) {
    throw new Error('Transcript start entry must be earlier than its end entry.');
  }
  const text = formatTaskTranscript(reversed.reverse(), reference.fromEntryId, reference.toEntryId);
  if (text === undefined) throw new Error('Transcript task boundaries are invalid.');
  return text;
}
