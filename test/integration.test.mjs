import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RpcPeer } from '../rpc.mjs';
import { STATE, STATS, TOOL } from '../policy.mjs';
import { compareCosts } from '../cost.mjs';
import { formatTaskTranscript } from '../presentation.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const LEAD = { provider: 'anthropic', id: 'fixture-lead', thinking: 'medium' };
const SIDEKICK = { provider: 'openai-codex', id: 'gpt-5.6-luna', thinking: 'max' };
const ALT_SIDEKICK = { provider: 'openai', id: 'fixture-sidekick', thinking: 'high' };

function savedTaskTranscript(reference) {
  const entries = readFileSync(reference.sessionFile, 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.type !== 'session');
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch = [];
  let entry = byId.get(reference.toEntryId);
  while (entry) {
    branch.push(entry);
    if (entry.id === reference.fromEntryId || (reference.fromEntryId === null && entry.parentId === null)) break;
    entry = byId.get(entry.parentId);
  }
  return formatTaskTranscript(branch.reverse(), reference.fromEntryId, reference.toEntryId);
}

test('native pi: pair, persistent context, hooks/UI, cancellation, errors, resume and fork', { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sidekick-integration-'));
  const agentDir = join(dir, 'agent');
  const sessionDir = join(agentDir, 'custom-current-sessions');
  const cwd = join(dir, 'work');
  mkdirSync(agentDir); mkdirSync(sessionDir); mkdirSync(cwd);
  writeFileSync(join(cwd, 'input.txt'), 'offline fixture content');
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    extensions: [join(project, 'test/fixture.ts')],
    defaultProvider: LEAD.provider, defaultModel: LEAD.id, defaultThinkingLevel: 'medium',
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const legacyConfigFile = join(agentDir, 'fusion.json');
  const legacyConfig = JSON.stringify({ sidekick: SIDEKICK, animation: false, timeoutMinutes: 90 });
  writeFileSync(legacyConfigFile, legacyConfig);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SIDEKICK_TEST: '1', PI_SIDEKICK_TEST_LOG: join(dir, 'events.jsonl'), PI_SIDEKICK_TEST_STATUS_LOG: join(dir, 'statuses.jsonl') };
  delete env.PI_SIDEKICK_WORKER;
  let peer;
  let notifications = [];
  let permissions = 0;
  let setupChoice = 'cancel';
  const setupMenus = [];
  const progress = [];
  const fixtureEvents = () => readFileSync(env.PI_SIDEKICK_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const statuses = () => existsSync(env.PI_SIDEKICK_TEST_STATUS_LOG)
    ? readFileSync(env.PI_SIDEKICK_TEST_STATUS_LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).text)
    : [];
  const open = async sessionFile => {
    peer = new RpcPeer('pi', ['--mode', 'rpc', '--offline', '--approve', '--no-extensions',
      '-e', join(project, 'test/status-hook-probe.ts'), '-e', join(project, 'test/fixture.ts'),
      '--session-dir', sessionDir,
      '--provider', LEAD.provider, '--model', LEAD.id, '--thinking', 'medium',
      ...(sessionFile ? ['--session', sessionFile] : [])], {
      cwd, env,
      onEvent: event => {
        if (event.type === 'tool_execution_update' && event.toolName === TOOL) {
          progress.push(event.partialResult?.content?.map(part => part.text ?? '').join('\n'));
        }
      },
      onUi: request => {
        if (request.method === 'notify') notifications.push(request.message);
        if (request.method === 'confirm') { permissions++; return { confirmed: false }; }
        if (request.method === 'select') {
          setupMenus.push(request);
          if (setupChoice === 'current') return { value: request.options[0] };
          if (setupChoice === 'sixty') return { value: request.title.includes('task timeout') ? request.options.find(option => option.startsWith('60 minutes')) : request.options[0] };
        }
        if (request.method === 'select' && ['alternate', 'cancel-timeout'].includes(setupChoice)) {
          if (request.title.includes('Sidekick setup · model')) return { value: request.options.find(option => option.startsWith('openai/')) };
          if (request.title.includes('reasoning')) return { value: 'high' };
          if (request.title.includes('task timeout')) {
            return setupChoice === 'cancel-timeout' ? { cancelled: true } : { value: request.options.find(option => option.startsWith('90 minutes')) };
          }
        }
        return { cancelled: true };
      },
    });
    return peer.request('get_state');
  };
  const prompt = async message => {
    const settled = peer.waitForEvent(e => e.type === 'agent_settled', { timeoutMs: 30000 });
    void settled.catch(() => {});
    await peer.request('prompt', { message });
    await settled;
    return (await peer.request('get_last_assistant_text')).text;
  };
  const checkpoint = async () => {
    const { entries } = await peer.request('get_entries');
    return entries.findLast(e => e.type === 'custom' && e.customType === STATE)?.data?.checkpoint;
  };
  try {
    const initialState = await open();
    const initialEntries = await peer.request('get_entries');
    const initialSidekickState = initialEntries.entries.findLast(e => e.type === 'custom' && e.customType === STATE);
    const commands = await peer.request('get_commands');
    assert(commands.commands.some(c => c.name === 'sidekick'), JSON.stringify(commands));
    assert(!commands.commands.some(c => c.name === 'fusion'), JSON.stringify(commands));
    assert.equal(initialState.model.provider, LEAD.provider);
    assert.equal(initialState.model.id, LEAD.id);
    assert.equal(initialState.thinkingLevel, LEAD.thinking);
    assert.equal(initialSidekickState?.data.enabled, true, 'new sessions default to Sidekick ON');
    assert.equal(existsSync(env.PI_SIDEKICK_TEST_LOG), false, 'auto-on must not spawn the worker');
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, 'sidekick.json'), 'utf8')), { sidekick: SIDEKICK, timeoutMinutes: 90 });
    assert.equal(readFileSync(legacyConfigFile, 'utf8'), legacyConfig, 'legacy config remains untouched');

    const activityRunning = peer.waitForEvent(e => e.type === 'tool_execution_update' && e.toolName === TOOL
      && JSON.stringify(e.partialResult).includes('▶ read')
      && JSON.stringify(e.partialResult).includes('input.txt'), { timeoutMs: 30000 });
    const activityCompleted = peer.waitForEvent(e => e.type === 'tool_execution_update' && e.toolName === TOOL
      && JSON.stringify(e.partialResult).includes('✓ read')
      && JSON.stringify(e.partialResult).includes('input.txt'), { timeoutMs: 30000 });
    void activityRunning.catch(() => {});
    void activityCompleted.catch(() => {});
    const first = await prompt('READ first');
    const runningUpdate = await activityRunning;
    const completedUpdate = await activityCompleted;
    assert.match(JSON.stringify(runningUpdate.partialResult), /Working · \d+ms/);
    assert.match(JSON.stringify(runningUpdate.partialResult), /▶ read.*input\.txt/);
    assert.equal(runningUpdate.partialResult.details.actions.length, 1);
    assert.match(JSON.stringify(completedUpdate.partialResult), /✓ read.*input\.txt/);
    assert.equal(completedUpdate.partialResult.details.actionCount, 1);
    assert(Number.isFinite(completedUpdate.partialResult.details.durationMs));
    assert.match(first, /offline fixture content/, first);
    const firstTaskResult = (await peer.request('get_entries')).entries.findLast(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === TOOL);
    const firstTranscriptRef = firstTaskResult.message.details.transcript;
    assert(firstTranscriptRef?.toEntryId, JSON.stringify(firstTaskResult.message.details));
    assert.equal(firstTranscriptRef.fromEntryId, null);
    const firstTranscript = savedTaskTranscript(firstTranscriptRef);
    assert.match(firstTranscript, /Tool call · read/);
    assert.match(firstTranscript, /Tool result · read/);
    assert.match(firstTranscript, /offline fixture content/);
    const firstCheckpoint = await checkpoint();
    assert(firstCheckpoint?.file, JSON.stringify(notifications));
    const second = await prompt('READ second');
    assert.match(second, /history=2/, second);
    const secondTaskResult = (await peer.request('get_entries')).entries.findLast(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === TOOL);
    const secondTranscriptRef = secondTaskResult.message.details.transcript;
    assert.equal(secondTranscriptRef.fromEntryId, firstTranscriptRef.toEntryId);
    assert.match(savedTaskTranscript(secondTranscriptRef), /READ second/);
    assert.doesNotMatch(savedTaskTranscript(firstTranscriptRef), /READ second/);
    assert.equal((await checkpoint()).file, firstCheckpoint.file);

    await prompt('WRITE');
    assert.equal(readFileSync(join(cwd, 'output.txt'), 'utf8'), 'written by Luna');
    await prompt('PERMISSION');
    assert.equal(permissions, 1);
    assert.equal(existsSync(join(cwd, 'denied.txt')), false);

    await prompt('SIBLING');
    assert.equal(existsSync(join(cwd, 'lead-must-not-write.txt')), false);
    const beforeFailure = await checkpoint();
    const failed = await prompt('FAIL');
    assert.match(failed, /did not finish successfully/, failed);
    const failedToolResult = (await peer.request('get_entries')).entries.findLast(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === TOOL);
    assert.equal(failedToolResult.message.isError, true, 'worker failure remains a native tool error');
    assert(Number.isFinite(failedToolResult.message.details.durationMs));
    assert.equal(failedToolResult.message.details.costRecord.outcome, 'error');
    const afterFailure = await checkpoint();
    assert(failed.includes(afterFailure.file), failed);
    assert.notEqual(afterFailure.leaf, beforeFailure.leaf, 'failed task history must be checkpointed');

    const sessionFile = (await peer.request('get_state')).sessionFile;
    const saved = await checkpoint();
    await peer.close();
    await open(sessionFile);
    const resumed = await prompt('READ resumed');
    assert.match(resumed, /offline fixture content/, resumed);
    assert.equal((await checkpoint()).file, saved.file, 'normal resume must preserve cache/session identity');

    const preForkStats = (await peer.request('get_entries')).entries.filter(e => e.type === 'custom' && e.customType === STATS).map(e => e.data);
    assert(preForkStats.some(record => record.outcome === 'error'));
    assert(preForkStats.filter(record => record.outcome === 'error').every(record => compareCosts(record).sidekickCost > 0), 'failed work is not free');
    assert.equal(new Set(preForkStats.map(record => record.callId)).size, preForkStats.length, 'failed delegation is recorded once');

    // A clone must branch the sidekick, not append to the original lead's child.
    const beforeClone = await checkpoint();
    await peer.request('clone');
    await prompt('READ cloned');
    assert.notEqual((await checkpoint()).file, beforeClone.file);

    const forkMessages = await peer.request('get_fork_messages');
    const secondPrompt = forkMessages.messages.find(m => m.text === 'READ second');
    assert(secondPrompt);
    const statusesBeforeFork = statuses().length;
    await peer.request('fork', { entryId: secondPrompt.entryId });
    assert(statuses().slice(statusesBeforeFork).some(text => text?.startsWith('Sidekick · ') && text.includes('≈ saved $')),
      'forked lead branch must refresh footer savings from that branch');
    const rewound = await prompt('READ rewound');
    assert.match(rewound, /history=2/, 'fork must not leak abandoned future briefs into Luna');

    const working = peer.waitForEvent(e => e.type === 'tool_execution_update' && e.toolName === TOOL
      && JSON.stringify(e.partialResult).includes('▶ bash')
      && JSON.stringify(e.partialResult).includes('sleep 30'), { timeoutMs: 30000 });
    void working.catch(() => {});
    await peer.request('prompt', { message: 'WAIT' });
    await working;
    await peer.waitForEvent(e => e.type === 'tool_execution_update' && e.toolName === TOOL
      && e.partialResult?.content?.[0]?.text?.startsWith('⠙ Working'), { timeoutMs: 5000 });
    await peer.request('abort', {}, 10000);
    assert.equal((await peer.request('get_state')).isStreaming, false);
    const cancelledToolResult = (await peer.request('get_entries')).entries.findLast(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === TOOL);
    assert.equal(cancelledToolResult.message.isError, true, 'cancellation remains a native tool error');
    assert(Number.isFinite(cancelledToolResult.message.details.durationMs));
    assert.equal(cancelledToolResult.message.details.costRecord.outcome, 'cancelled');
    assert.equal(cancelledToolResult.message.details.actionCount, 1);
    const afterCancel = await checkpoint();
    assert(afterCancel?.leaf);
    const recovered = await prompt('READ after cancellation');
    assert.match(recovered, /offline fixture content/, recovered);

    const statsEntries = (await peer.request('get_entries')).entries.filter(e => e.type === 'custom' && e.customType === STATS).map(e => e.data);
    assert(statsEntries.some(record => record.outcome === 'success'));
    for (const record of statsEntries) {
      const comparison = compareCosts(record);
      assert.equal(comparison.available, true, JSON.stringify(record));
      assert.equal(comparison.percentage, 75);
      assert.equal(record.lead.rates.input, 4);
      assert.equal(record.sidekick.rates.input, 1);
    }
    assert(statsEntries.some(record => record.outcome === 'cancelled'));
    assert(!statsEntries.some(record => record.outcome === 'error'), 'forked stats must exclude abandoned failures');
    assert.equal(new Set(statsEntries.map(record => record.callId)).size, statsEntries.length, 'each delegation gets one cost record');
    const legacyStatsRecord = { ...statsEntries[0], callId: `legacy-${statsEntries[0].callId}` };
    await peer.request('prompt', { message: `/fixture-legacy-stats ${JSON.stringify(legacyStatsRecord)}` });
    await peer.request('prompt', { message: '/sidekick stats' });
    assert(notifications.some(n => n.includes(`Calls: ${statsEntries.length + 1}`) && n.includes('Sidekick delegated cost estimates') && n.includes('75.0% lower')));
    const currentLeadFile = (await peer.request('get_state')).sessionFile;
    const defaultCopyDir = join(agentDir, 'sessions', '--stats-default-copy--');
    mkdirSync(defaultCopyDir, { recursive: true });
    const defaultCopy = join(defaultCopyDir, 'fork-copy.jsonl');
    copyFileSync(currentLeadFile, defaultCopy);
    const customProbe = join(sessionDir, 'custom-dir-only.jsonl');
    const defaultProbe = join(defaultCopyDir, 'default-dir-only.jsonl');
    const malformedBody = join(sessionDir, 'malformed-body.jsonl');
    const unreadableSession = join(sessionDir, 'unreadable-session.jsonl');
    const probeSession = (id, outcome) => {
      const probeRecord = { ...statsEntries[0], callId: id, outcome, durationMs: 123 };
      return `${JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() })}\n${JSON.stringify({ type: 'custom', id: `${id}-entry`, parentId: null, timestamp: new Date().toISOString(), customType: STATS, data: probeRecord })}\n`;
    };
    writeFileSync(customProbe, probeSession('custom-dir-only', 'custom-dir-only'));
    writeFileSync(defaultProbe, probeSession('default-dir-only', 'default-dir-only'));
    writeFileSync(malformedBody, `${JSON.stringify({ type: 'session', version: 3, id: 'malformed-body', cwd, timestamp: new Date().toISOString() })}\n{broken\n`);
    writeFileSync(unreadableSession, 'not a session header\n');
    const inputFiles = [defaultCopy, customProbe, defaultProbe, malformedBody, unreadableSession];
    const inputBytes = inputFiles.map(path => readFileSync(path));
    await peer.request('prompt', { message: '/sidekick stats all' });
    const allStats = notifications.findLast(n => n.includes('all sessions') && n.includes('Sidekick delegated cost estimates'));
    assert(allStats, notifications.join('\n'));
    assert.match(allStats, /Calls: [1-9][0-9]*/);
    assert.match(allStats, /Duration: .* known · .* unknown/);
    assert.match(allStats, /custom-dir-only: 1/, 'configured session directory is discovered');
    assert.match(allStats, /default-dir-only: 1/, 'default session directories are discovered');
    assert.match(allStats, /Read-only scan warnings: 1 malformed JSONL line · 1 unreadable file/);
    assert.deepEqual(inputFiles.map(path => readFileSync(path)), inputBytes,
      'all-session stats must not rewrite discovered session files');

    const events = readFileSync(env.PI_SIDEKICK_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    const modelCalls = events.filter(e => e.model);
    assert(modelCalls.some(e => e.child));
    for (const call of modelCalls) {
      const expected = call.child ? SIDEKICK : LEAD;
      assert.equal(call.provider, expected.provider);
      assert.equal(call.model, expected.id);
      assert.equal(call.thinking, call.child ? expected.thinking : call.thinking === 'high' ? 'high' : expected.thinking);
      if (!call.child) assert(['medium', 'high'].includes(call.thinking));
    }
    assert(events.some(e => e.child && e.hook === 'read'), 'native child tool_call hooks must run');
    const childPrompts = modelCalls.filter(e => e.child).map(e => e.prompt);
    assert(childPrompts.every(p => p.startsWith('Sidekick brief')), 'do not forward the lead conversation');

    await peer.request('set_thinking_level', { level: 'high' });
    const unchangedLead = await peer.request('get_state');
    assert.equal(unchangedLead.model.provider, LEAD.provider);
    assert.equal(unchangedLead.model.id, LEAD.id);
    assert.equal(unchangedLead.thinkingLevel, 'high');
    const nonOpenAiLead = await prompt('READ with non-OpenAI lead');
    assert.match(nonOpenAiLead, /offline fixture content/, nonOpenAiLead);

    const readHooksBefore = fixtureEvents().filter(event => event.child && event.hook === 'read').length;
    const stormReport = await prompt('TOOL_STORM_65');
    assert.match(stormReport, /LUNA completed 65 calls/, stormReport);
    const readHooksAfter = fixtureEvents().filter(event => event.child && event.hook === 'read').length;
    assert.equal(readHooksAfter - readHooksBefore, 65, 'all 65 allowlisted worker tool calls must reach execution');

    const resultEntries = (await peer.request('get_entries')).entries;
    const delegationResults = resultEntries.filter(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === TOOL);
    assert(delegationResults.some(e => e.message.usage?.totalTokens > 0), 'sidekick usage must contribute to the lead session');
    for (const record of statsEntries) {
      const result = delegationResults.find(e => e.message.toolCallId === record.callId)?.message;
      assert(result, 'record has matching native tool result');
      assert.equal(result.usage.cost.total, record.usage.cost.total, 'analytics must not duplicate native cost');
      assert.equal(result.usage.input, record.usage.input);
      assert.equal(result.details.durationMs, record.durationMs);
      assert.equal(result.details.costRecord.outcome, record.outcome);
    }

    await peer.request('prompt', { message: '/sidekick off' });
    assert(notifications.some(n => n.includes('Sidekick OFF')));
    await peer.request('prompt', { message: '/sidekick on' });
    assert(notifications.some(n => n.includes('Sidekick ON')));
    await peer.request('prompt', { message: '/sidekick off' });
    assert(statuses().some(text => text?.startsWith('Sidekick off · ≈ saved $')),
      'saved estimate remains visible after /sidekick off');
    const offSessionFile = (await peer.request('get_state')).sessionFile;
    await peer.close();
    await open(offSessionFile);
    const reopenedEntries = await peer.request('get_entries');
    const reopenedSidekickState = reopenedEntries.entries.findLast(e => e.type === 'custom' && e.customType === STATE);
    assert.equal(reopenedSidekickState?.data.enabled, false, 'explicit off persists across reload');
    assert(statuses().some(text => text?.startsWith('Sidekick off · ≈ saved $')),
      'reloaded off session restores its branch savings in the footer');
    const configFile = join(agentDir, 'sidekick.json');
    const currentConfig = readFileSync(configFile, 'utf8');
    assert.doesNotMatch(currentConfig, /animation/);
    assert.equal(readFileSync(legacyConfigFile, 'utf8'), legacyConfig);
    await peer.request('prompt', { message: '/sidekick setup' });
    assert.equal(readFileSync(configFile, 'utf8'), currentConfig, 'cancelled setup must preserve Sidekick config');
    setupChoice = 'cancel-timeout';
    await peer.request('prompt', { message: '/sidekick setup' });
    assert.equal(readFileSync(configFile, 'utf8'), currentConfig, 'cancelling timeout selection must preserve config and history');
    setupChoice = 'alternate';
    setupMenus.length = 0;
    await peer.request('prompt', { message: '/sidekick setup' });
    assert.match(setupMenus[0].title, /Current: .*max · 90 minutes/);
    assert.match(setupMenus[0].options[0], /openai-codex\/gpt-5\.6-luna.*\(Current\)$/);
    assert.deepEqual(setupMenus[2].options, ['90 minutes (Current)', '15 minutes', '30 minutes', '60 minutes', '120 minutes', '240 minutes']);
    const selectedConfig = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.deepEqual(selectedConfig, { sidekick: ALT_SIDEKICK, timeoutMinutes: 90 });
    await peer.request('prompt', { message: '/sidekick status' });
    assert(notifications.some(n => n.includes('timeout 90 minutes')), notifications.join('\n'));
    setupChoice = 'current';
    setupMenus.length = 0;
    await peer.request('prompt', { message: '/sidekick setup' });
    assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), selectedConfig, 'accepting all focused current options keeps raw values');
    assert(setupMenus.every(menu => menu.options[0].endsWith('(Current)')));
    assert.equal(setupMenus[1].options[0], 'high (Current)');
    setupChoice = 'sixty';
    await peer.request('prompt', { message: '/sidekick setup' });
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).timeoutMinutes, 60);
    setupChoice = 'current';
    setupMenus.length = 0;
    await peer.request('prompt', { message: '/sidekick setup' });
    assert.deepEqual(setupMenus[2].options, ['60 minutes (Current)', '15 minutes', '30 minutes', '120 minutes', '240 minutes']);
    assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), { sidekick: ALT_SIDEKICK, timeoutMinutes: 60 });
    const leadAfterSetup = await peer.request('get_state');
    assert.equal(leadAfterSetup.model.provider, LEAD.provider);
    assert.equal(leadAfterSetup.model.id, LEAD.id);
    const progressStart = progress.length;
    const alternateReport = await prompt('ALT setup');
    assert.match(alternateReport, /offline fixture content/, alternateReport);
    assert(progress.length > progressStart);
    assert(progress.slice(progressStart).some(text => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working/.test(text)), 'delegation must emit the Working spinner');
    assert(progress.slice(progressStart).every(text => !text.includes('▰')), 'legacy animation=false must not disable the braille spinner');
    const alternateSession = (await peer.request('get_state')).sessionFile;
    await peer.close();
    await open(alternateSession);
    const resumedLead = await peer.request('get_state');
    assert.equal(resumedLead.model.provider, LEAD.provider);
    assert.equal(resumedLead.model.id, LEAD.id);
    await prompt('ALT resumed');
    const alternateCalls = readFileSync(env.PI_SIDEKICK_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(event => event.child && event.provider === ALT_SIDEKICK.provider && event.model === ALT_SIDEKICK.id);
    assert(alternateCalls.length >= 2, 'setup and resume must launch the selected sidekick');
    assert(alternateCalls.every(event => event.thinking === ALT_SIDEKICK.thinking));

    const leadSessionFile = (await peer.request('get_state')).sessionFile;
    const originalCheckpoint = await checkpoint();
    const legacySessions = join(agentDir, 'fusion', 'sessions');
    mkdirSync(legacySessions, { recursive: true });
    const legacyFile = join(legacySessions, `legacy-${basename(originalCheckpoint.file)}`);
    copyFileSync(originalCheckpoint.file, legacyFile);
    const legacyBytes = readFileSync(legacyFile);
    const seedLegacyCheckpoint = file => peer.request('prompt', {
      message: `/fixture-legacy-checkpoint ${JSON.stringify({ file, leaf: originalCheckpoint.leaf })}`,
    });
    await seedLegacyCheckpoint(legacyFile);
    await peer.close();
    await open(leadSessionFile);
    const migratedReport = await prompt('READ legacy checkpoint');
    assert.match(migratedReport, /offline fixture content/, migratedReport);
    assert.match(migratedReport, /history=[2-9][0-9]*/, migratedReport);
    const mappedFile = join(agentDir, 'sidekick', 'sessions', basename(legacyFile));
    assert(existsSync(mappedFile));
    assert.equal((await checkpoint()).file, mappedFile);
    assert.deepEqual(readFileSync(legacyFile), legacyBytes, 'legacy session log remains unchanged');
    const migratedBytes = readFileSync(mappedFile);

    await seedLegacyCheckpoint(legacyFile);
    await peer.close();
    await open(leadSessionFile);
    const repeatedReport = await prompt('READ repeated legacy checkpoint');
    assert.match(repeatedReport, /offline fixture content/, repeatedReport);
    assert.deepEqual(readFileSync(mappedFile), migratedBytes, 'repeated restore must not overwrite the newer copy');
    assert.deepEqual(readFileSync(legacyFile), legacyBytes, 'repeated restore must not rewrite the source');

    const outsideFile = join(dir, 'outside.jsonl');
    copyFileSync(legacyFile, outsideFile);
    await seedLegacyCheckpoint(outsideFile);
    await peer.close();
    await open(leadSessionFile);
    const outsideReport = await prompt('READ external legacy checkpoint');
    assert.match(outsideReport, /outside its session directory/, outsideReport);
    assert.equal(existsSync(join(agentDir, 'sidekick', 'sessions', basename(outsideFile))), false);

    const escapedLink = join(legacySessions, 'escaped.jsonl');
    symlinkSync(outsideFile, escapedLink);
    await seedLegacyCheckpoint(escapedLink);
    await peer.close();
    await open(leadSessionFile);
    const symlinkReport = await prompt('READ symlink-escaped legacy checkpoint');
    assert.match(symlinkReport, /outside its session directory/, symlinkReport);
    assert.equal(existsSync(join(agentDir, 'sidekick', 'sessions', basename(escapedLink))), false);
  } finally {
    await peer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native pi: missing auth fails closed until explicit off', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sidekick-startup-failure-'));
  const agentDir = join(dir, 'agent');
  const cwd = join(dir, 'work');
  mkdirSync(agentDir); mkdirSync(cwd);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    extensions: [join(project, 'test/fixture.ts')],
    defaultProvider: LEAD.provider, defaultModel: LEAD.id, defaultThinkingLevel: 'medium',
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SIDEKICK_TEST_STATUS_LOG: join(dir, 'statuses.jsonl'),
    PI_OFFLINE: '1',
    PI_SIDEKICK_TEST: '1',
    PI_SIDEKICK_TEST_NO_AUTH: '1',
    PI_SIDEKICK_TEST_LOG: join(dir, 'events.jsonl'),
  };
  delete env.PI_SIDEKICK_WORKER;
  let peer;
  const notifications = [];
  try {
    peer = new RpcPeer('pi', ['--mode', 'rpc', '--offline', '--approve', '--no-extensions',
      '-e', join(project, 'test/status-hook-probe.ts'), '-e', join(project, 'test/fixture.ts'),
      '--provider', LEAD.provider, '--model', LEAD.id, '--thinking', 'medium'], {
      cwd, env,
      onUi: request => {
        if (request.method === 'notify') notifications.push(request.message);
        return { cancelled: true };
      },
    });
    await peer.request('get_state');
    assert(notifications.some(n => n.includes('Sidekick startup failed')), notifications.join('\\n'));
    assert(notifications.some(n => n.includes('Input is blocked')), notifications.join('\\n'));
    assert(readFileSync(env.PI_SIDEKICK_TEST_STATUS_LOG, 'utf8').includes('Sidekick · startup error'),
      'startup warning remains visible in footer status');

    await peer.request('prompt', { message: '/sidekick reset' });
    const resetEntries = await peer.request('get_entries');
    assert.equal(resetEntries.entries.some(e => e.type === 'custom' && e.customType === STATE), false);
    assert(notifications.some(n => n.includes('use /sidekick setup, /sidekick on or /sidekick off')), notifications.join('\\n'));

    await peer.request('prompt', { message: 'READ blocked' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(existsSync(env.PI_SIDEKICK_TEST_LOG), false, 'blocked input must not reach any model');

    await peer.request('prompt', { message: '/sidekick off' });
    const entries = await peer.request('get_entries');
    const state = entries.entries.findLast(e => e.type === 'custom' && e.customType === STATE);
    assert.equal(state?.data.enabled, false);
    assert(notifications.some(n => n.includes('Sidekick OFF')), notifications.join('\\n'));
  } finally {
    await peer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
