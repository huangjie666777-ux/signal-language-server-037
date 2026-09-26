'use strict';
// Minimal JSON-RPC client for talking to the sig language server over stdio.
const { spawn } = require('child_process');

class LspClient {
  constructor(command, args, options = {}) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], ...options });
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.requestHandlers = new Map();
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) throw new Error('missing Content-Length header');
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.slice(start, start + length).toString('utf8');
      this.buffer = this.buffer.slice(start + length);
      this.#dispatch(JSON.parse(body));
    }
  }

  #dispatch(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id);
      if (entry) {
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      const handler = this.requestHandlers.get(message.method);
      const respond = (result) => this.#send({ jsonrpc: '2.0', id: message.id, result });
      if (handler) Promise.resolve(handler(message.params)).then(respond, () => respond(null));
      else respond(null);
      return;
    }
    const handler = this.notificationHandlers.get(message.method);
    if (handler) handler(message.params);
  }

  #send(message) {
    const body = JSON.stringify(message);
    this.child.stdin.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  waitForNotification(method, predicate = () => true, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + method)), timeoutMs);
      const previous = this.notificationHandlers.get(method);
      this.notificationHandlers.set(method, (params) => {
        if (previous) previous(params);
        if (predicate(params)) {
          clearTimeout(timer);
          resolve(params);
        }
      });
    });
  }

  async stop() {
    try {
      await this.request('shutdown');
      this.notify('exit');
    } finally {
      this.child.kill();
    }
  }
}

module.exports = { LspClient };
