import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RpcPeer } from '../rpc.mjs';
import { STATE, STATS, TOOL } from '../policy.mjs';
import { compareCosts } from '../cost.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const LEAD = { provider: 'anthropic', id: 'fixture-lead', thinking: 'medium' };
const SIDEKICK = { provider: 'openai-codex', id: 'gpt-5.6-luna', thinking: 'max' };
const ALT_SIDEKICK = { provider: 'openai', id: 'fixture-sidekick', thinking: 'high' };

test('native pi: pair, persistent context, hooks/UI, cancellation, errors, resume and fork', { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fusion-integration-'));
  const agentDir = join(dir, 'agent');
  const cwd = join(dir, 'work');
  mkdirSync(agentDir); mkdirSync(cwd);
  writeFileSync(join(cwd, 'input.txt'), 'offline fixture content');
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    extensions: [join(project, 'test/fixture.ts')],
    defaultProvider: LEAD.provider, defaultModel: LEAD.id, defaultThinkingLevel: 'medium',
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  writeFileSync(join(agentDir, 'fusion.json'), JSON.stringify({ sidekick: SIDEKICK, animation: false, timeoutMinutes: 90 }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_FUSION_TEST: '1', PI_FUSION_TEST_LOG: join(dir, 'events.jsonl') };
  delete env.PI_FUSION_WORKER;
  let peer;
  let notifications = [];
  let permissions = 0;
  let setupChoice = 'cancel';
  const setupMenus = [];
  const progress = [];
  const fixtureEvents = () => readFileSync(env.PI_FUSION_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const open = async sessionFile => {
    peer = new RpcPeer('pi', ['--mode', 'rpc', '--offline', '--approve', '--no-extensions',
      '-e', join(project, 'index.ts'), '-e', join(project, 'test/fixture.ts'),
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
          if (request.title.includes('sidekick model')) return { value: request.options.find(option => option.startsWith('openai/')) };
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
    const initialFusionState = initialEntries.entries.findLast(e => e.type === 'custom' && e.customType === STATE);
    const commands = await peer.request('get_commands');
    assert(commands.commands.some(c => c.name === 'sidekick'), JSON.stringify(commands));
    assert(!commands.commands.some(c => c.name === 'fusion'), JSON.stringify(commands));
    assert.equal(initialState.model.provider, LEAD.provider);
    assert.equal(initialState.model.id, LEAD.id);
    assert.equal(initialState.thinkingLevel, LEAD.thinking);
    assert.equal(initialFusionState?.data.enabled, true, 'new sessions default to Fusion ON');
    assert.equal(existsSync(env.PI_FUSION_TEST_LOG), false, 'auto-on must not spawn Luna');

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
    assert.match(JSON.stringify(runningUpdate.partialResult), /▶ read.*input\.txt/);
    assert.match(JSON.stringify(completedUpdate.partialResult), /✓ read.*input\.txt/);
    assert.match(first, /offline fixture content/, first);
    const firstCheckpoint = await checkpoint();
    assert(firstCheckpoint?.file, JSON.stringify(notifications));
    const second = await prompt('READ second');
    assert.match(second, /history=2/, second);
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
    await peer.request('fork', { entryId: secondPrompt.entryId });
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
    await peer.request('prompt', { message: '/sidekick stats' });
    assert(notifications.some(n => n.includes('Fusion delegated cost estimates') && n.includes('75.0% lower')));

    const events = readFileSync(env.PI_FUSION_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
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
    assert(childPrompts.every(p => p.startsWith('Fusion brief')), 'do not forward the lead conversation');

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
    }

    await peer.request('prompt', { message: '/sidekick off' });
    assert(notifications.some(n => n.includes('Fusion OFF')));
    await peer.request('prompt', { message: '/sidekick on' });
    assert(notifications.some(n => n.includes('Fusion ON')));
    await peer.request('prompt', { message: '/sidekick off' });
    const offSessionFile = (await peer.request('get_state')).sessionFile;
    await peer.close();
    await open(offSessionFile);
    const reopenedEntries = await peer.request('get_entries');
    const reopenedFusionState = reopenedEntries.entries.findLast(e => e.type === 'custom' && e.customType === STATE);
    assert.equal(reopenedFusionState?.data.enabled, false, 'explicit off persists across reload');
    const configFile = join(agentDir, 'fusion.json');
    const legacyConfig = readFileSync(configFile, 'utf8');
    assert.match(legacyConfig, /"animation":false/);
    await peer.request('prompt', { message: '/sidekick setup' });
    assert.equal(readFileSync(configFile, 'utf8'), legacyConfig, 'cancelled setup must preserve legacy config');
    setupChoice = 'cancel-timeout';
    await peer.request('prompt', { message: '/sidekick setup' });
    assert.equal(readFileSync(configFile, 'utf8'), legacyConfig, 'cancelling timeout selection must preserve config and history');
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
    const alternateCalls = readFileSync(env.PI_FUSION_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(event => event.child && event.provider === ALT_SIDEKICK.provider && event.model === ALT_SIDEKICK.id);
    assert(alternateCalls.length >= 2, 'setup and resume must launch the selected sidekick');
    assert(alternateCalls.every(event => event.thinking === ALT_SIDEKICK.thinking));
  } finally {
    await peer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native pi: missing auth fails closed until explicit off', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fusion-startup-failure-'));
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
    PI_OFFLINE: '1',
    PI_FUSION_TEST: '1',
    PI_FUSION_TEST_NO_AUTH: '1',
    PI_FUSION_TEST_LOG: join(dir, 'events.jsonl'),
  };
  delete env.PI_FUSION_WORKER;
  let peer;
  const notifications = [];
  try {
    peer = new RpcPeer('pi', ['--mode', 'rpc', '--offline', '--approve', '--no-extensions',
      '-e', join(project, 'index.ts'), '-e', join(project, 'test/fixture.ts'),
      '--provider', LEAD.provider, '--model', LEAD.id, '--thinking', 'medium'], {
      cwd, env,
      onUi: request => {
        if (request.method === 'notify') notifications.push(request.message);
        return { cancelled: true };
      },
    });
    await peer.request('get_state');
    assert(notifications.some(n => n.includes('Fusion startup failed')), notifications.join('\\n'));
    assert(notifications.some(n => n.includes('Input is blocked')), notifications.join('\\n'));

    await peer.request('prompt', { message: '/sidekick reset' });
    const resetEntries = await peer.request('get_entries');
    assert.equal(resetEntries.entries.some(e => e.type === 'custom' && e.customType === STATE), false);
    assert(notifications.some(n => n.includes('use /sidekick setup, /sidekick on or /sidekick off')), notifications.join('\\n'));

    await peer.request('prompt', { message: 'READ blocked' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(existsSync(env.PI_FUSION_TEST_LOG), false, 'blocked input must not reach any model');

    await peer.request('prompt', { message: '/sidekick off' });
    const entries = await peer.request('get_entries');
    const state = entries.entries.findLast(e => e.type === 'custom' && e.customType === STATE);
    assert.equal(state?.data.enabled, false);
    assert(notifications.some(n => n.includes('Fusion OFF')), notifications.join('\\n'));
  } finally {
    await peer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
