import { formatDuration } from './activity.mjs';

export const COST_CATEGORIES = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
const RATE_KEYS = COST_CATEGORIES;

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function valueOrZero(value) {
  return value === undefined ? 0 : value;
}

function ratesOf(value) {
  return value?.rates ?? value?.cost ?? value ?? {};
}

export function snapshotModel(model) {
  const cost = model?.rates ?? model?.cost ?? {};
  return {
    provider: typeof model?.provider === 'string' ? model.provider : 'unknown',
    id: typeof model?.id === 'string' ? model.id : 'unknown',
    rates: Object.fromEntries(RATE_KEYS.map(key => [key, cost[key] ?? null])),
  };
}

export function snapshotUsage(usage) {
  return {
    ...Object.fromEntries(COST_CATEGORIES.map(key => [key, usage?.[key] ?? 0])),
    cost: Object.fromEntries([...COST_CATEGORIES, 'total'].map(key => [key, usage?.cost?.[key] ?? null])),
    costReported: usage?.costReported === true || (usage?.costReported === undefined && usage?.cost?.total !== undefined),
  };
}

function tokensOf(usage) {
  const tokens = {};
  for (const key of COST_CATEGORIES) {
    const value = valueOrZero(usage?.[key]);
    if (!finiteNonNegative(value)) return { unavailable: true, reason: `invalid ${key} token usage` };
    tokens[key] = value;
  }
  const consumed = COST_CATEGORIES.reduce((sum, key) => sum + tokens[key], 0);
  return { tokens, consumed };
}

export function costForUsage(usage, ratesValue) {
  const tokenResult = tokensOf(usage);
  if (tokenResult.unavailable) return { available: false, reason: tokenResult.reason };
  const { tokens, consumed } = tokenResult;
  if (consumed === 0) return { available: false, reason: 'no consumed tokens', tokens, consumed };
  const rates = ratesOf(ratesValue);
  let total = 0;
  let hasPositiveRate = false;
  for (const key of RATE_KEYS) {
    if (tokens[key] === 0) continue;
    const rate = rates[key];
    if (!finiteNonNegative(rate)) return { available: false, reason: `missing or invalid ${key} price`, tokens, consumed };
    if (rate > 0) hasPositiveRate = true;
    total += tokens[key] * rate / 1_000_000;
  }
  if (!hasPositiveRate) return { available: false, reason: 'all consumed-token prices are zero', tokens, consumed };
  if (!Number.isFinite(total)) return { available: false, reason: 'cost exceeds numeric range', tokens, consumed };
  return { available: true, cost: total, tokens, consumed };
}

function reportedCost(usage) {
  const total = usage?.cost?.total;
  if (usage?.costReported === false || total === undefined || total === null) return { present: false };
  return finiteNonNegative(total) ? { present: true, value: total } : { present: true, invalid: true };
}

export function compareCosts({ usage, lead, sidekick }) {
  const sidekickResult = costForUsage(usage, sidekick?.rates ?? sidekick);
  const leadResult = costForUsage(usage, lead?.rates ?? lead);
  if (!sidekickResult.available || !leadResult.available) {
    return {
      available: false,
      reason: sidekickResult.available ? `lead: ${leadResult.reason}` : leadResult.available ? `sidekick: ${sidekickResult.reason}` : `sidekick: ${sidekickResult.reason}; lead: ${leadResult.reason}`,
      sidekick: sidekickResult,
      lead: leadResult,
    };
  }
  const reported = reportedCost(usage);
  if (reported.invalid || (reported.present && reported.value === 0)) {
    return { available: false, reason: 'reported sidekick cost is invalid or zero for priced consumption', sidekick: sidekickResult, lead: leadResult };
  }
  const sidekickCost = reported.present ? reported.value : sidekickResult.cost;
  const leadCost = leadResult.cost;
  if (!finiteNonNegative(sidekickCost) || !finiteNonNegative(leadCost) || leadCost === 0) {
    return { available: false, reason: leadCost === 0 ? 'zero lead-equivalent baseline' : 'invalid estimated cost', sidekick: sidekickResult, lead: leadResult };
  }
  const difference = leadCost - sidekickCost;
  if (!Number.isFinite(difference / leadCost * 100)) return { available: false, reason: 'comparison exceeds numeric range' };
  return {
    available: true,
    sidekickCost,
    leadCost,
    difference,
    percentage: difference / leadCost * 100,
    tokens: leadResult.tokens,
    sidekick: sidekickResult,
    lead: leadResult,
  };
}

export function makeDelegationRecord(callId, lead, sidekick, usage, outcome, durationMs) {
  return {
    callId: String(callId),
    lead: snapshotModel(lead),
    sidekick: snapshotModel(sidekick),
    usage: snapshotUsage(usage),
    outcome,
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs: Math.round(durationMs) } : {}),
  };
}

export function dedupeDelegationRecords(records) {
  const byCall = new Map();
  for (const record of records ?? []) {
    if (record?.callId) byCall.set(record.callId, record);
  }
  return [...byCall.values()];
}

function money(value) {
  if (!finiteNonNegative(value)) return 'unavailable';
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 6 : 2;
  return `$${value.toFixed(digits)}`;
}

function comparisonText(comparison) {
  const amount = Math.abs(comparison.difference);
  if (comparison.difference > 0) return `estimated ${money(amount)} lower (${comparison.percentage.toFixed(1)}% lower)`;
  if (comparison.difference < 0) return `estimated ${money(amount)} higher (${Math.abs(comparison.percentage).toFixed(1)}% higher)`;
  return 'estimated difference $0.00 (0.0%)';
}

export function formatTaskCost(record, compact = false) {
  const comparison = compareCosts(record);
  const outcome = record.outcome ?? 'unknown';
  if (!comparison.available) {
    const unavailable = `Estimated cost comparison unavailable (${comparison.reason}). Outcome: ${outcome}.`;
    return compact ? unavailable : `${unavailable} Excludes lead planning/review; tokenization, context and retries differ. Subscription billing is not represented by API-rate estimates.`;
  }
  const summary = `Estimated costs: ${money(comparison.sidekickCost)} Sidekick · ${money(comparison.leadCost)} lead-equivalent for the same tokens · ${comparisonText(comparison)}.`;
  return compact ? summary : `${summary} Outcome: ${outcome}. Excludes lead planning/review; tokenization, context and retries differ. Subscription billing is not represented by API-rate estimates.`;
}

export function formatCompactTaskCost(record) {
  const comparison = compareCosts(record);
  const sidekickCost = comparison.available ? comparison.sidekickCost : comparison.sidekick?.available ? comparison.sidekick.cost : undefined;
  const leadCost = comparison.available ? comparison.leadCost : comparison.lead?.available ? comparison.lead.cost : undefined;
  const headline = `Sidekick ${sidekickCost === undefined ? 'unavailable' : money(sidekickCost)} · Lead equivalent ${leadCost === undefined ? 'unavailable' : money(leadCost)}`;
  if (!comparison.available) return `${headline}\n≈ Estimate unavailable`;
  if (comparison.difference > 0) return `${headline}\n≈ Saved ${money(comparison.difference)} (${comparison.percentage.toFixed(1)}%) · API-rate estimate`;
  if (comparison.difference < 0) return `${headline}\n≈ Extra cost ${money(-comparison.difference)} (${Math.abs(comparison.percentage).toFixed(1)}%) · API-rate estimate`;
  return `${headline}\n≈ No estimated difference · API-rate estimate`;
}

function addFinite(sum, value) {
  const total = sum + value;
  return Number.isFinite(total) ? total : undefined;
}

function totals(records) {
  const unique = dedupeDelegationRecords(records);
  const estimates = unique.map(record => ({ record, comparison: compareCosts(record) }));
  const comparable = estimates.filter(item => item.comparison.available);
  let sidekickCost = 0;
  let leadCost = 0;
  let aggregateAvailable = true;
  for (const { comparison } of comparable) {
    const nextSidekick = addFinite(sidekickCost, comparison.sidekickCost);
    const nextLead = addFinite(leadCost, comparison.leadCost);
    if (nextSidekick === undefined || nextLead === undefined) aggregateAvailable = false;
    else { sidekickCost = nextSidekick; leadCost = nextLead; }
  }
  let difference;
  let percentage;
  if (aggregateAvailable && comparable.length) {
    difference = leadCost - sidekickCost;
    percentage = leadCost === 0 ? 0 : difference / leadCost * 100;
    aggregateAvailable = Number.isFinite(difference) && Number.isFinite(percentage);
  }
  const knownDurations = unique.filter(record => typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0);
  let durationMs = 0;
  let durationAvailable = true;
  for (const { durationMs: value } of knownDurations) {
    const next = addFinite(durationMs, value);
    if (next === undefined) durationAvailable = false;
    else durationMs = next;
  }
  return {
    unique,
    comparable,
    unavailable: unique.length - comparable.length,
    sidekickCost,
    leadCost,
    aggregateAvailable,
    difference,
    percentage,
    knownDurationCount: knownDurations.length,
    unknownDurationCount: unique.length - knownDurations.length,
    durationMs,
    durationAvailable,
  };
}

function totalComparison(difference, percentage) {
  const text = difference > 0
    ? `estimated ${money(difference)} lower (${percentage.toFixed(1)}% lower)`
    : difference < 0
      ? `estimated ${money(-difference)} higher (${Math.abs(percentage).toFixed(1)}% higher)`
      : 'estimated difference $0.00 (0.0%)';
  return { difference, text };
}

function unavailableMarker(count) {
  return count > 0 ? ` · +${count} unavailable` : '';
}

export function formatCompactSavings(records) {
  const summary = totals(records);
  if (summary.unique.length === 0) return undefined;
  const suffix = summary.comparable.length > 0 ? unavailableMarker(summary.unavailable) : '';
  if (!summary.aggregateAvailable || summary.comparable.length === 0) return `estimate unavailable${suffix}`;
  const { difference } = summary;
  if (difference > 0) return `≈ saved ${money(difference)}${suffix}`;
  if (difference < 0) return `≈ extra ${money(-difference)}${suffix}`;
  return `≈ no difference${suffix}`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function scanWarnings(malformedLines, unreadableFiles) {
  if (malformedLines === 0 && unreadableFiles === 0) return '';
  return `\nRead-only scan warnings: ${plural(malformedLines, 'malformed JSONL line')} · ${plural(unreadableFiles, 'unreadable file')}; saved-history totals may be incomplete.`;
}

function durationSummary(summary) {
  const { knownDurationCount: known, unknownDurationCount: unknown } = summary;
  const total = known === 0 ? 'not recorded'
    : summary.durationAvailable ? formatDuration(summary.durationMs) : 'unavailable (numeric range exceeded)';
  return `\nDuration: ${total} · ${known} known · ${unknown} unknown`;
}

export function formatStats(records, options = {}) {
  const scope = options.scope ?? 'this branch';
  const malformedLines = options.malformedLines ?? 0;
  const unreadableFiles = options.unreadableFiles ?? options.skipped ?? 0;
  const warning = scanWarnings(malformedLines, unreadableFiles);
  const summary = totals(records);
  const { unique, comparable, unavailable } = summary;
  const emptyScope = scope === 'this branch' ? 'in this branch' : `in ${scope}`;
  if (unique.length === 0) return `No delegated Sidekick cost history ${emptyScope}. Older sessions have no retroactive estimate.${warning}`;
  const outcomes = unique.reduce((counts, record) => {
    counts[record.outcome ?? 'unknown'] = (counts[record.outcome ?? 'unknown'] ?? 0) + 1;
    return counts;
  }, {});
  const outcomeText = Object.entries(outcomes).map(([name, count]) => `${name}: ${count}`).join(', ');
  const header = `Sidekick delegated cost estimates · ${scope} (delegated work only)\nCalls: ${unique.length} · comparable: ${comparable.length} · unavailable: ${unavailable}\nOutcomes: ${outcomeText}${durationSummary(summary)}`;
  if (comparable.length === 0) return `${header}\nNo comparable calls; no aggregate baseline is applied to unavailable calls.${warning}`;
  if (!summary.aggregateAvailable) return `${header}\nAggregate totals unavailable: numeric range exceeded; individual records remain valid.${warning}`;
  const comparison = totalComparison(summary.difference, summary.percentage);
  return `${header}\nComparable totals: ${money(summary.sidekickCost)} estimated Sidekick cost · ${money(summary.leadCost)} lead-equivalent for the same tokens · ${comparison.text}\nUnavailable calls are excluded from these comparable totals. Excludes lead planning/review; tokenization, context and retries differ. Subscription billing is not represented by API-rate estimates.${warning}`;
}
