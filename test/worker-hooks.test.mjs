import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RpcPeer } from '../rpc.mjs';
import { WORKER_CONFIG_ENV, WORKER_ENV } from '../policy.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const sidekick = { provider: 'openai-codex', id: 'gpt-5.6-luna', thinking: 'max' };

test('worker tool_call hook allows 65 calls and still blocks disallowed tools', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fusion-worker-hooks-'));
  const agentDir = join(dir, 'agent');
  const cwd = join(dir, 'work');
  const resultFile = join(dir, 'result');
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_FUSION_TEST: '1',
    PI_FUSION_TEST_LOG: join(dir, 'events.jsonl'),
    PI_FUSION_HOOK_TEST_RESULT: resultFile,
    [WORKER_ENV]: '1',
    [WORKER_CONFIG_ENV]: JSON.stringify(sidekick),
  };
  let peer;
  try {
    peer = new RpcPeer('pi', ['--mode', 'rpc', '--offline', '--approve', '--no-extensions',
      '-e', join(project, 'test/fixture.ts'), '-e', join(project, 'test/worker-hook-probe.ts'),
      '--provider', sidekick.provider, '--model', sidekick.id, '--thinking', sidekick.thinking], { cwd, env });
    await peer.request('get_state');
    assert(existsSync(resultFile), 'actual worker hook probe did not complete');
    assert.equal(readFileSync(resultFile, 'utf8'), 'ok');
  } finally {
    await peer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
