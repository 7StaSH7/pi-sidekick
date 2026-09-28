import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RpcPeer } from '../rpc.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const LEAD = { provider: 'anthropic', id: 'fixture-lead', thinking: 'medium' };
const SIDEKICK = { provider: 'openai-codex', id: 'gpt-5.6-luna', thinking: 'max' };

test('native SDK sessions own independent Sidekicks without policing host agent tools', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sidekick-orchestration-'));
  const agentDir = join(dir, 'agent');
  const hostCwd = join(dir, 'host');
  const cwdA = join(dir, 'agent-a-workspace');
  const cwdB = join(dir, 'agent-b-workspace');
  const cwdUntrusted = join(dir, 'untrusted');
  const sessionDir = join(dir, 'host-sessions');
  const resultFile = join(dir, 'result.json');
  const nativeLog = join(dir, 'native-tools.jsonl');
  const eventLog = join(dir, 'events.jsonl');
  for (const path of [agentDir, hostCwd, cwdA, cwdB, cwdUntrusted, sessionDir]) mkdirSync(path, { recursive: true });
  writeFileSync(join(cwdA, 'input.txt'), 'agent A only');
  writeFileSync(join(cwdB, 'input.txt'), 'agent B only');
  writeFileSync(join(cwdUntrusted, 'input.txt'), 'untrusted only');
  writeFileSync(join(agentDir, 'sidekick.json'), JSON.stringify({ sidekick: SIDEKICK, timeoutMinutes: 1 }));
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SIDEKICK_TEST: '1',
    PI_SIDEKICK_TEST_LOG: eventLog,
    PI_SIDEKICK_NATIVE_TOOL_LOG: nativeLog,
    PI_SIDEKICK_ORCHESTRATION_RESULT: resultFile,
    PI_SIDEKICK_ORCHESTRATION_CWD_A: cwdA,
    PI_SIDEKICK_ORCHESTRATION_CWD_B: cwdB,
    PI_SIDEKICK_ORCHESTRATION_CWD_UNTRUSTED: cwdUntrusted,
  };
  delete env.PI_SIDEKICK_WORKER;
  let peer;
  try {
    peer = new RpcPeer('pi', [
      '--mode', 'rpc', '--offline', '--approve', '--no-extensions',
      '-e', join(project, 'test/fixture.ts'),
      '-e', join(project, 'test/orchestration-probe.ts'),
      '--session-dir', sessionDir,
      '--provider', LEAD.provider, '--model', LEAD.id, '--thinking', LEAD.thinking,
    ], { cwd: hostCwd, env });
    await peer.request('get_state');
    const commands = (await peer.request('get_commands')).commands.map(command => command.name);
    assert(commands.includes('fixture-orchestration'), `Probe command was not registered: ${commands.join(', ')}`);
    const response = await peer.request('prompt', { message: '/fixture-orchestration' }, 90000);
    for (let attempt = 0; attempt < 300 && !existsSync(resultFile); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const entries = (await peer.request('get_entries')).entries;
    const lastAssistant = entries.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant')?.message;
    assert(existsSync(resultFile), `SDK orchestration probe did not write a result (response: ${JSON.stringify(response)}, assistant: ${JSON.stringify(lastAssistant)})`);
    const report = JSON.parse(readFileSync(resultFile, 'utf8'));
    assert(!report.error, report.stack ?? report.error);

    assert.notEqual(report.checkpoints.a.file, report.checkpoints.b.file);
    assert.notEqual(report.owners.a, report.owners.b);
    assert.equal(report.checkpoints.a.owner, report.owners.a);
    assert.equal(report.checkpoints.b.owner, report.owners.b);
    assert.deepEqual(report.workers.a, { id: report.workers.a.id, cwd: cwdA });
    assert.deepEqual(report.workers.b, { id: report.workers.b.id, cwd: cwdB });
    assert.notEqual(report.workers.a.id, report.workers.b.id);
    assert.deepEqual(report.files, { outputA: false, outputB: true, outputUntrusted: false }, 'Sidekick writes only in an assigned trusted session cwd');
    assert(report.stats.a.includes('cancelled'), JSON.stringify(report.stats));
    assert(report.stats.b.includes('success'), JSON.stringify(report.stats));
    assert.deepEqual(report.trustedNativeCallsEnabled.map(call => call.name), ['Agent', 'SubagentWorkflow']);
    assert.deepEqual(report.trustedNativeCallsOff.map(call => call.name), ['Agent', 'SubagentWorkflow']);
    assert.deepEqual(report.trustedNativeResults.map(({ name, isError }) => [name, isError]), [
      ['Agent', false], ['SubagentWorkflow', false], ['Agent', false], ['SubagentWorkflow', false],
    ]);
    assert.deepEqual(report.untrustedNativeCallsEnabled.map(call => call.name), ['Agent', 'SubagentWorkflow']);
    assert.deepEqual(report.untrustedNativeCallsOff.map(call => call.name), ['Agent', 'SubagentWorkflow']);
    assert.deepEqual(report.untrustedNativeResults.map(({ name, isError }) => [name, isError]), [
      ['Agent', false], ['SubagentWorkflow', false], ['Agent', false], ['SubagentWorkflow', false],
    ]);
    assert.equal(report.untrustedSidekickResult.isError, true);
    assert.match(report.untrustedSidekickResult.text, /Sidekick requires a trusted project/);
    assert.equal(report.files.outputUntrusted, false);
    assert.equal(report.untrustedSidekickCheckpoint, null);
    assert.deepEqual(report.untrustedStats, []);
    assert.deepEqual(report.untrustedWorkerSessions.after, report.untrustedWorkerSessions.before,
      'untrusted Sidekick attempts must not create a worker session');
    assert.deepEqual(report.untrustedWorkerCalls, [], 'untrusted Sidekick attempts must not reach the worker model');
    assert(report.workerCalls.length >= 4, 'both independent workers should execute more than one task');
    assert(report.workerCalls.every(call => call.provider === SIDEKICK.provider && call.model === SIDEKICK.id && call.thinking === SIDEKICK.thinking),
      'each worker stays pinned to the selected provider/model/reasoning without fallback');
  } finally {
    await peer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
