import { clean, formatActivityActions, formatDuration } from './activity.mjs';
import { compareCosts, formatCompactTaskCost, formatTaskCost } from './cost.mjs';

export function callText(args, expanded, theme) {
  const title = theme.fg('toolTitle', theme.bold('Sidekick'));
  if (!expanded) return `${title}\n${theme.fg('muted', clean(args.brief, 120) || 'Preparing delegation…')}`;
  return `${title}\n${args.brief ?? ''}\n\nConstraints\n${args.constraints ?? ''}\n\nSuccess criteria\n${args.success_criteria ?? ''}`;
}

function safeTranscriptText(value) {
  return String(value ?? '')
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ');
}

function messageText(content) {
  if (typeof content === 'string') return safeTranscriptText(content);
  return (content ?? []).map(part => part?.type === 'text'
    ? safeTranscriptText(part.text)
    // ponytail: text rendering omits binary images; add inline Image components for visual transcript support.
    : part?.type === 'image' ? `[${safeTranscriptText(part.mimeType ?? 'image')} omitted]` : '').filter(Boolean).join('\n');
}

export function formatTranscript(entries) {
  const output = [];
  for (const entry of entries) {
    if (entry.type === 'compaction' && entry.summary) {
      output.push(`Compaction summary\n${safeTranscriptText(entry.summary)}`);
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'user') {
      const text = messageText(message.content);
      if (text) output.push(`Sidekick brief\n${text}`);
      continue;
    }
    if (message?.role === 'assistant') {
      for (const part of message.content ?? []) {
        if (part?.type === 'text' && part.text) output.push(`Sidekick\n${safeTranscriptText(part.text)}`);
        if (part?.type === 'toolCall' || part?.type === 'tool_use') {
          let args;
          try { args = JSON.stringify(part.arguments ?? part.input ?? {}, null, 2); }
          catch { args = '[arguments unavailable]'; }
          output.push(`Tool call · ${safeTranscriptText(part.name ?? part.toolName ?? 'tool')}\nArguments\n${safeTranscriptText(args)}`);
        }
      }
      continue;
    }
    if (message?.role === 'toolResult') {
      const text = messageText(message.content);
      output.push(`Tool result · ${safeTranscriptText(message.toolName ?? 'tool')}\n${text || '[no text output]'}`);
    }
  }
  return output.join('\n\n');
}

export function formatTaskTranscript(branch, fromEntryId, toEntryId) {
  if (!Array.isArray(branch) || typeof toEntryId !== 'string' || (fromEntryId !== null && typeof fromEntryId !== 'string')) return undefined;
  const end = branch.findIndex(entry => entry.id === toEntryId);
  const start = fromEntryId === null ? -1 : branch.findIndex(entry => entry.id === fromEntryId);
  if (end < 0 || (fromEntryId !== null && start < 0) || start >= end) return undefined;
  return formatTranscript(branch.slice(start + 1, end + 1));
}

function progressText(text, theme) {
  return text.split('\n').map((line, index) => {
    if (index === 0) return theme.fg('accent', line.slice(0, 1)) + theme.fg('muted', line.slice(1));
    if (index === 1) return theme.fg('dim', line);
    const color = line.startsWith('✗') ? 'error' : line.startsWith('✓') ? 'success' : 'accent';
    return theme.fg(color, line.slice(0, 1)) + theme.fg('muted', line.slice(1));
  }).join('\n');
}

function resultHeading(details, isError, theme) {
  const label = isError
    ? details.costRecord?.outcome === 'cancelled' ? '✗ Cancelled' : '✗ Failed'
    : '✓ Complete';
  const heading = theme.fg(isError ? 'error' : 'success', label);
  const metadata = [];
  if (Number.isFinite(details.durationMs)) metadata.push(formatDuration(details.durationMs));
  if (Number.isFinite(details.actionCount)) metadata.push(`${details.actionCount} ${details.actionCount === 1 ? 'action' : 'actions'}`);
  return `${heading}${metadata.length ? ` · ${metadata.join(' · ')}` : ''}`;
}

function resultReport(text) {
  return text.split(/\n\n(?:Estimated costs:|Estimated delegated cost:|Estimated cost comparison unavailable(?:\s|\())/)[0];
}

function compactCost(record, theme) {
  const lines = formatCompactTaskCost(record).split('\n');
  const comparison = compareCosts(record);
  const color = !comparison.available ? 'warning'
    : comparison.difference > 0 ? 'success'
      : comparison.difference < 0 ? 'error' : 'warning';
  return `${theme.fg('muted', lines[0])}\n${theme.fg(color, lines[1])}`;
}

export function resultText(result, { isPartial, expanded, isError, expandHint = 'to expand', transcriptText, transcriptError }, theme) {
  const details = result.details ?? {};
  const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (isPartial) {
    if (expanded && Array.isArray(details.actions)) {
      const header = text.split('\n').slice(0, 2).join('\n');
      return progressText([header, formatActivityActions(details.actions)].filter(Boolean).join('\n'), theme);
    }
    return `${progressText(text, theme)}\n${theme.fg('dim', expandHint)}`;
  }

  const cost = details.costRecord
    ? expanded ? formatTaskCost(details.costRecord) : compactCost(details.costRecord, theme)
    : '';
  const unavailableTranscript = transcriptError
    ? `Saved Sidekick transcript unavailable: ${transcriptError}.\n\nTask report/error\n${resultReport(text)}`
    : undefined;
  if (isError) {
    const body = expanded
      ? transcriptText ? `${transcriptText}\n\nError\n${text}` : unavailableTranscript ?? text
      : text;
    const more = expanded ? '' : `\n${theme.fg('dim', expandHint)}`;
    return `${resultHeading(details, true, theme)}\n${theme.fg('error', body)}${cost ? `\n${theme.fg('dim', cost)}` : ''}${more}`;
  }
  if (expanded) {
    const body = transcriptText ?? unavailableTranscript ?? text;
    const session = details.sessionFile ? `\n\nSidekick session: ${details.sessionFile}\nLead: verify the actual diff and checks before declaring completion.` : '';
    return `${resultHeading(details, false, theme)}\n${theme.fg('toolOutput', body)}${cost ? `\n\n${theme.fg('dim', cost)}` : ''}${session ? theme.fg('dim', session) : ''}`;
  }
  const preview = resultReport(text).split('\n').slice(0, 5).join('\n');
  const more = `\n… ${expandHint}`;
  return `${resultHeading(details, false, theme)}\n${theme.fg('toolOutput', preview)}${more}${cost ? `\n${cost}` : ''}`;
}
