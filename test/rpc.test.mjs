import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { RpcPeer } from '../rpc.mjs';

const fixture = String.raw`
const { createInterface } = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', async line => {
  const m = JSON.parse(line);
  const reply = (data, success = true) => send({ type: 'response', id: m.id, success, data, error: 'denied' });
  switch (m.type) {
    case 'echo': setTimeout(() => reply(m.value), m.delay || 0); break;
    case 'fail': reply(null, false); break;
    case 'hang': break;
    case 'prompt': send({ type: 'agent_settled', value: 42 }); reply('accepted'); break;
    case 'unicode': {
      process.stdout.write('extension debug log\n');
      const bytes = Buffer.from(JSON.stringify({ type: 'response', id: m.id, success: true, data: 'a\u2028b\u2029😀' }) + '\n');
      const split = bytes.indexOf(Buffer.from('😀')) + 2;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
      break;
    }
    case 'ui': send({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm' }); reply(); break;
    case 'extension_ui_response': send({ type: 'ui_result', message: m }); break;
    case 'exit': process.stderr.write('secret-token='.repeat(2000)); process.exit(7); break;
    case 'oversize': process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1)); break;
    case 'stubborn': process.on('SIGTERM', () => {}); reply(); break;
    case 'descendant': {
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => reply(child.pid));
      break;
    }
  }
});
`;

function peer(t, options) {
  const rpc = new RpcPeer(process.execPath, ['-e', fixture], options);
  t.after(() => rpc.close());
  return rpc;
}

test('correlates concurrent requests and reports RPC errors', async t => {
  const rpc = peer(t);
  const first = rpc.request('echo', { value: 1, delay: 30, id: 'overridden', type: 'fail' });
  const second = rpc.request('echo', { value: 2 });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  await assert.rejects(rpc.request('fail'), /denied/);
  assert.equal(rpc.alive, true);
});

test('LF framing preserves Unicode separators and split UTF-8; ignores log lines', async t => {
  assert.equal(await peer(t).request('unicode'), 'a\u2028b\u2029😀');
});

test('waiter sees agent_settled emitted before prompt response', async t => {
  const observed = [];
  const rpc = peer(t, { onEvent: async event => { observed.push(event); throw new Error('observer'); } });
  const settled = rpc.waitForEvent(event => event.type === 'agent_settled');
  assert.equal(await rpc.request('prompt'), 'accepted');
  assert.equal((await settled).value, 42);
  assert.equal(observed[0].type, 'agent_settled');
});

test('UI callback forwards matching id and denies absent or failing handlers', async t => {
  for (const [onUi, fields] of [
    [async () => ({ confirmed: true, id: 'wrong', type: 'wrong' }), { confirmed: true }],
    [async () => { throw new Error('UI failed'); }, { cancelled: true }],
    [() => { throw new Error('sync'); }, { cancelled: true }],
    [undefined, { cancelled: true }],
  ]) {
    const rpc = peer(t, { onUi });
    const result = rpc.waitForEvent(event => event.type === 'ui_result');
    await rpc.request('ui');
    assert.deepEqual((await result).message, {
      ...fields,
      type: 'extension_ui_response', id: 'ui-1',
    });
    await rpc.close();
  }
});

test('send forwards manual messages', async t => {
  const rpc = peer(t);
  const result = rpc.waitForEvent(event => event.type === 'ui_result');
  rpc.send({ type: 'extension_ui_response', id: 'manual', value: 'hello' });
  assert.equal((await result).message.value, 'hello');
});

test('request timeout leaves peer usable', async t => {
  const rpc = peer(t);
  await assert.rejects(rpc.request('hang', {}, 20), /timed out/);
  assert.equal(await rpc.request('echo', { value: 'ok' }), 'ok');
});

test('event wait abort, timeout and predicate errors remove listeners', async t => {
  const rpc = peer(t);
  const controller = new AbortController();
  const waiting = rpc.waitForEvent(() => false, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(rpc.waitForEvent(() => true, { signal: controller.signal }), { name: 'AbortError' });
  const other = new AbortController();
  await assert.rejects(rpc.waitForEvent(() => false, { signal: other.signal, timeoutMs: 10 }), /timed out/);
  assert.equal(getEventListeners(other.signal, 'abort').length, 0);
  const broken = assert.rejects(rpc.waitForEvent(() => { throw new Error('predicate'); }), /predicate/);
  await rpc.request('prompt');
  await broken;
});

test('abnormal exit rejects all pending without leaking stderr', async t => {
  const rpc = peer(t);
  const check = error => {
    assert.match(error.message, /RPC/);
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  };
  const checks = [assert.rejects(rpc.request('hang'), check),
    assert.rejects(rpc.waitForEvent(() => false), check),
    assert.rejects(rpc.request('exit'), check)];
  await Promise.all(checks);
  assert.equal(rpc.alive, false);
  await rpc.close();
});

test('oversized unterminated frames reject pending work', async t => {
  const rpc = peer(t);
  await assert.rejects(rpc.request('oversize'), /exceeds 8 MiB/);
  assert.equal(rpc.alive, false);
});

test('close cancels pending requests, waits and late UI callback', async t => {
  let resolveUi;
  const rpc = peer(t, { onUi: () => new Promise(resolve => { resolveUi = resolve; }) });
  await rpc.request('ui');
  const controller = new AbortController();
  const checks = [assert.rejects(rpc.request('hang'), /closed/),
    assert.rejects(rpc.waitForEvent(() => false, { signal: controller.signal }), /closed/)];
  const closing = rpc.close();
  assert.equal(rpc.close(), closing);
  assert.equal(rpc.alive, false);
  resolveUi({ confirmed: true });
  await Promise.all([...checks, closing]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(rpc.request('echo'), /closed/);
  assert.throws(() => rpc.send({}), /closed/);
});

test('close escalates to SIGKILL for stubborn process', { timeout: 4000 }, async t => {
  const rpc = peer(t);
  await rpc.request('stubborn');
  const start = Date.now();
  await rpc.close();
  assert.ok(Date.now() - start < 2500);
});

test('Linux close kills descendants after leader exits', { skip: process.platform !== 'linux', timeout: 4000 }, async t => {
  const rpc = peer(t);
  await rpc.request('descendant');
  // Descendant inherits stderr: close cannot resolve until that child dies.
  await rpc.close();
  assert.equal(rpc.alive, false);
});

test('spawn failure rejects work and closes', async () => {
  const rpc = new RpcPeer('/no-such-pi-fusion-command', []);
  await assert.rejects(rpc.request('echo'), /RPC/);
  await rpc.close();
  assert.equal(rpc.alive, false);
});
