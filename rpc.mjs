import { spawn } from 'node:child_process';

const MAX_FRAME = 8 * 1024 * 1024;

export class RpcPeer {
  #child;
  #pending = new Map();
  #waiters = new Set();
  #nextId = 0;
  #error;
  #closing;
  #closed;
  #buffer = '';
  #bufferBytes = 0;
  #stderr = Buffer.alloc(0);
  #onEvent;
  #onUi;

  constructor(command, args, { cwd, env, onEvent, onUi } = {}) {
    this.#onEvent = onEvent;
    this.#onUi = onUi;
    this.#child = spawn(command, args, {
      cwd, env, shell: false, detached: process.platform === 'linux',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#closed = new Promise(resolve => this.#child.once('close', resolve));
    this.#child.on('error', () => this.#stop(new Error('RPC process error')));
    this.#child.on('exit', (code, signal) => {
      this.#stop(new Error(`RPC process exited (${signal ?? code})`));
    });
    this.#child.stdin.on('error', () => this.#stop(new Error('RPC input closed')));
    this.#child.stdout.on('error', () => this.#stop(new Error('RPC output error')));
    this.#child.stderr.on('error', () => this.#stop(new Error('RPC stderr error')));
    this.#child.stderr.on('data', chunk => {
      this.#stderr = Buffer.from(Buffer.concat([this.#stderr, chunk]).subarray(-8192));
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', chunk => this.#read(chunk));
  }

  get alive() { return !this.#error && !this.#closing; }

  send(message) {
    if (!this.alive) throw this.#error ?? new Error('RPC closed');
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(type, fields = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(this.#error ?? new Error('RPC closed'));
      const id = String(++this.#nextId);
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC request timed out: ${type}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...fields, type, id });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  waitForEvent(predicate, { signal, timeoutMs = 900000 } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('RPC wait aborted'));
      if (!this.alive) return reject(this.#error ?? new Error('RPC closed'));
      const finish = (error, event) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.#waiters.delete(waiter);
        if (error !== null) reject(error);
        else resolve(event);
      };
      const abort = () => finish(signal.reason ?? new Error('RPC wait aborted'));
      const waiter = { predicate, finish };
      const timer = setTimeout(() => finish(new Error('RPC event timed out')), timeoutMs);
      this.#waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  #read(chunk) {
    if (!this.alive) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf('\n', start);
      const part = chunk.slice(start, end < 0 ? chunk.length : end);
      this.#bufferBytes += Buffer.byteLength(part);
      if (this.#bufferBytes > MAX_FRAME) {
        this.#stop(new Error('RPC stdout frame exceeds 8 MiB'));
        return;
      }
      this.#buffer += part;
      if (end < 0) return;
      const line = this.#buffer;
      this.#buffer = '';
      this.#bufferBytes = 0;
      start = end + 1;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      this.#dispatch(message);
      if (!this.alive) return;
    }
  }

  #dispatch(message) {
    if (message.type === 'response') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.data);
      else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'RPC request failed'));
      return;
    }
    for (const waiter of [...this.#waiters]) {
      try {
        if (waiter.predicate(message)) waiter.finish(null, message);
      } catch (error) { waiter.finish(error); }
    }
    // Event observers must not crash the transport or leak rejected promises.
    Promise.resolve().then(() => this.#onEvent?.(message)).catch(() => {});
    if (message.type === 'extension_ui_request') {
      Promise.resolve().then(() => this.#onUi?.(message)).then(
        fields => this.#replyUi(message.id, fields),
        () => this.#replyUi(message.id),
      ).catch(() => {});
    }
  }

  #replyUi(id, fields) {
    if (!this.alive) return;
    this.send({ ...(fields ?? { cancelled: true }), type: 'extension_ui_response', id });
  }

  #fail(error) {
    this.#error ??= error;
    this.#buffer = '';
    this.#bufferBytes = 0;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#error);
    }
    this.#pending.clear();
    for (const waiter of [...this.#waiters]) waiter.finish(this.#error);
  }

  #stop(error) {
    this.#fail(error);
    void this.close().catch(() => {});
  }

  #kill(signal) {
    if (!this.#child.pid) return;
    try {
      if (process.platform === 'linux') process.kill(-this.#child.pid, signal);
      else this.#child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#fail(new Error('RPC closed'));
    this.#closing = (async () => {
      const wait = async ms => {
        let timer;
        try {
          return await Promise.race([
            this.#closed.then(() => true),
            new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); }),
          ]);
        } finally { clearTimeout(timer); }
      };
      this.#kill('SIGTERM');
      await wait(500);
      // Kill the group even if its leader exited, so surviving bash children stop.
      this.#kill('SIGKILL');
      if (!await wait(1000)) {
        this.#child.stdin.destroy();
        this.#child.stdout.destroy();
        this.#child.stderr.destroy();
        throw new Error('RPC process did not close after SIGKILL');
      }
    })();
    return this.#closing;
  }
}
