import test from 'node:test';
import assert from 'node:assert/strict';
import { costForUsage, compareCosts, formatStats, formatTaskCost, makeDelegationRecord, snapshotModel, snapshotUsage } from '../cost.mjs';

const usage = { input: 1_000_000, output: 2_000_000, cacheRead: 3_000_000, cacheWrite: 4_000_000 };
const model = (provider, id, cost) => ({ provider, id, cost });
const rates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 };

test('calculates input, output and cache categories without rounding', () => {
  const result = costForUsage(usage, rates);
  assert.equal(result.available, true);
  assert.equal(result.cost, 7.5);
  assert.deepEqual(snapshotUsage({ ...usage, cost: { total: 7.5 } }).cost.total, 7.5);
  const comparison = compareCosts({ usage, lead: { rates }, sidekick: { rates: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0.5 } } });
  assert.equal(comparison.available, true);
  assert.equal(comparison.sidekickCost, 15);
  assert.equal(comparison.leadCost, 7.5);
  assert.equal(comparison.difference, -7.5);
  assert.equal(comparison.percentage, -100);
  assert.match(formatTaskCost({ ...comparison, usage, lead: { rates }, sidekick: { rates: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0.5 } }, outcome: 'error' }), /higher/);
});

test('rejects missing, zero, negative and nonfinite prices or zero usage', () => {
  assert.match(costForUsage({ input: 1, output: 1 }, { input: 1 }).reason, /missing or invalid output/);
  assert.match(costForUsage({ input: 1 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }).reason, /zero/);
  assert.match(costForUsage({ input: 1 }, { input: -1, output: 1, cacheRead: 1, cacheWrite: 1 }).reason, /invalid input/);
  assert.match(costForUsage({ input: 1 }, { input: Number.NaN, output: 1, cacheRead: 1, cacheWrite: 1 }).reason, /invalid input/);
  assert.match(costForUsage({}, rates).reason, /no consumed tokens/);
  const zeroBaseline = compareCosts({ usage: { input: 1 }, lead: { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, sidekick: { rates } });
  assert.equal(zeroBaseline.available, false);
  assert.doesNotMatch(formatTaskCost({ usage: { input: 1 }, lead: { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, sidekick: { rates }, outcome: 'success' }), /NaN|100%/);
});

test('supports same-price zero difference and keeps model rate snapshots', () => {
  const lead = model('openai-codex', 'lead', rates);
  const sidekick = model('openai', 'sidekick', rates);
  const record = makeDelegationRecord('call-1', snapshotModel(lead), snapshotModel(sidekick), { input: 1_000_000 }, 'success');
  assert.deepEqual(record.lead, snapshotModel(lead));
  assert.deepEqual(record.sidekick, snapshotModel(sidekick));
  const comparison = compareCosts(record);
  assert.equal(comparison.available, true);
  assert.equal(comparison.difference, 0);
  assert.equal(comparison.percentage, 0);
  const zeroReported = compareCosts({ ...record, usage: { ...record.usage, cost: { total: 0 }, costReported: true } });
  assert.equal(zeroReported.available, false, 'zero reported cost with priced consumption must not claim 100% savings');
  assert.match(formatTaskCost(record), /difference \$0\.00 \(0\.0%\)/);
});

test('formats branch totals with deduplication, mixed rates and outcomes', () => {
  const lead = model('anthropic', 'lead', { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
  const cheap = model('openai', 'cheap', { input: 0.5, output: 0.5, cacheRead: 0.5, cacheWrite: 0.5 });
  const expensive = model('openai-codex', 'expensive', { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 });
  const first = makeDelegationRecord('same-call', lead, cheap, { input: 1_000_000 }, 'success');
  const replacement = makeDelegationRecord('same-call', lead, expensive, { input: 1_000_000 }, 'cancelled');
  const unavailable = makeDelegationRecord('unavailable', lead, model('openai', 'unknown', {}), { input: 1_000_000 }, 'error');
  const records = [first, replacement, unavailable];
  assert.match(formatStats(records), /Calls: 2 · comparable: 1 · unavailable: 1/);
  assert.match(formatStats(records), /cancelled: 1/);
  assert.match(formatStats(records), /error: 1/);
  assert.match(formatStats(records), /Unavailable calls are excluded/);
  assert.equal(formatStats([]), 'No delegated Fusion cost history in this branch. Older sessions have no retroactive estimate.');
});
