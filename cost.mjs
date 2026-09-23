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

export function makeDelegationRecord(callId, lead, sidekick, usage, outcome) {
  return {
    callId: String(callId),
    lead: snapshotModel(lead),
    sidekick: snapshotModel(sidekick),
    usage: snapshotUsage(usage),
    outcome,
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
    return `Estimated delegated cost: unavailable (${comparison.reason}). Outcome: ${outcome}.`;
  }
  const summary = `Estimated delegated cost: ${money(comparison.sidekickCost)} sidekick vs ${money(comparison.leadCost)} at lead rates; ${comparisonText(comparison)}.`;
  return compact ? summary : `${summary} Outcome: ${outcome}. Excludes lead planning/review; tokenization, context and retries differ. Subscription billing is not represented by API-rate estimates.`;
}

export function formatStats(records) {
  const unique = dedupeDelegationRecords(records);
  if (unique.length === 0) return 'No delegated Sidekick cost history in this branch. Older sessions have no retroactive estimate.';
  const estimates = unique.map(record => ({ record, comparison: compareCosts(record) }));
  const comparable = estimates.filter(item => item.comparison.available);
  const unavailable = unique.length - comparable.length;
  const outcomes = unique.reduce((counts, record) => {
    counts[record.outcome ?? 'unknown'] = (counts[record.outcome ?? 'unknown'] ?? 0) + 1;
    return counts;
  }, {});
  const outcomeText = Object.entries(outcomes).map(([name, count]) => `${name}: ${count}`).join(', ');
  const header = `Sidekick delegated cost estimates (delegated work only)\nCalls: ${unique.length} · comparable: ${comparable.length} · unavailable: ${unavailable}\nOutcomes: ${outcomeText}`;
  if (comparable.length === 0) return `${header}\nNo comparable calls; no aggregate baseline is applied to unavailable calls.`;
  const sidekickCost = comparable.reduce((sum, item) => sum + item.comparison.sidekickCost, 0);
  const leadCost = comparable.reduce((sum, item) => sum + item.comparison.leadCost, 0);
  const difference = leadCost - sidekickCost;
  const percentage = leadCost === 0 ? undefined : difference / leadCost * 100;
  const comparison = difference > 0
    ? `estimated ${money(difference)} lower (${percentage.toFixed(1)}% lower)`
    : difference < 0
      ? `estimated ${money(-difference)} higher (${Math.abs(percentage).toFixed(1)}% higher)`
      : 'estimated difference $0.00 (0.0%)';
  return `${header}\nComparable totals: ${money(sidekickCost)} sidekick · ${money(leadCost)} lead-equivalent · ${comparison}\nUnavailable calls are excluded from these comparable totals. Excludes lead planning/review; tokenization, context and retries differ. Subscription billing is not represented by API-rate estimates.`;
}
