import { clean } from './activity.mjs';
import { formatTaskCost } from './cost.mjs';

export function callText(args, expanded, theme) {
  const title = theme.fg('toolTitle', theme.bold('Fusion sidekick'));
  if (!expanded) return `${title}\n${theme.fg('muted', clean(args.brief, 120) || 'Preparing delegation…')}`;
  return `${title}\n${args.brief ?? ''}\n\nConstraints\n${args.constraints ?? ''}\n\nSuccess criteria\n${args.success_criteria ?? ''}`;
}

export function resultText(result, { isPartial, expanded, isError }, theme) {
  const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (isPartial) {
    return text.split('\n').map((line, index) => {
      if (index === 0) return theme.fg('accent', line.slice(0, 1)) + theme.fg('muted', line.slice(1));
      if (index === 1) return theme.fg('dim', line);
      const color = line.startsWith('✗') ? 'error' : line.startsWith('✓') ? 'success' : 'accent';
      return theme.fg(color, line.slice(0, 1)) + theme.fg('muted', line.slice(1));
    }).join('\n');
  }
  if (expanded || isError) return theme.fg(isError ? 'error' : 'toolOutput', text);
  const report = text.split('\n\nEstimated delegated cost:')[0];
  const lines = report.split('\n');
  const preview = lines.slice(0, 5).join('\n');
  const more = lines.length > 5 ? '\n… Expand for the full report' : '';
  const cost = result.details?.costRecord ? `\n${formatTaskCost(result.details.costRecord, true)}` : '';
  return theme.fg('success', '✓ Complete') + `\n${theme.fg('toolOutput', preview)}${theme.fg('dim', more + cost)}`;
}
