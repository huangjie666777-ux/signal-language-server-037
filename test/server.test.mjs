import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url));

class LspClient {
  constructor(rootUri) {
    this.proc = spawn(process.execPath, [serverPath, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => (this.stderr += d));
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = this.buffer.slice(0, headerEnd).toString('ascii');
        const len = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
        if (this.buffer.length < headerEnd + 4 + len) return;
        const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
        this.buffer = this.buffer.slice(headerEnd + 4 + len);
        this.dispatch(JSON.parse(body));
      }
    });
    this.rootUri = rootUri;
  }

  dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
      }
    } else if (msg.method) {
      this.notifications.push(msg);
      if (msg.method === 'window/logMessage') return;
      if (msg.id !== undefined) {
        // server -> client request (e.g. client/registerCapability): accept
        this.send({ jsonrpc: '2.0', id: msg.id, result: null });
      }
    }
  }

  send(msg) {
    const body = JSON.stringify(msg);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async waitForDiagnostics(uri, timeout = 5000) {
    const start = Date.now();
    for (;;) {
      const found = this.notifications.find(
        (n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri,
      );
      if (found) return found.params.diagnostics;
      if (Date.now() - start > timeout) throw new Error('timeout waiting for diagnostics of ' + uri);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async stop() {
    try {
      await this.request('shutdown');
      this.notify('exit');
    } catch { /* ignore */ }
    await new Promise((r) => this.proc.once('exit', r));
  }
}

let dir;
let rootUri;
let client;
const uri = (name) => pathToFileURL(path.join(dir, name)).toString();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-lsp-'));
  fs.writeFileSync(path.join(dir, 'signals.sig'), 'signal ready:bool\nsignal speed:number\n');
  fs.writeFileSync(path.join(dir, 'links.sig'), 'connect speed->ready\n');
  rootUri = pathToFileURL(dir).toString();
  client = new LspClient(rootUri);
  const init = await client.request('initialize', {
    processId: process.pid,
    rootUri,
    capabilities: {},
  });
  assert.equal(init.capabilities.definitionProvider, true);
  assert.equal(init.capabilities.referencesProvider, true);
  assert.equal(init.capabilities.renameProvider, true);
  assert.equal(init.capabilities.textDocumentSync.change, 2);
  client.notify('initialized', {});
});

after(async () => {
  await client.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publishes diagnostics for disk files after initialize', async () => {
  const d = await client.waitForDiagnostics(uri('links.sig'));
  assert.equal(d.length, 1);
  assert.match(d[0].message, /Type mismatch/);
});

test('stdout carries only protocol frames', () => {
  assert.equal(client.stderr.includes('syntax error'), false);
});

test('didOpen uses unsaved text; incremental didChange updates diagnostics', async () => {
  const u = uri('scratch.sig');
  client.notify('textDocument/didOpen', {
    textDocument: { uri: u, languageId: 'sig', version: 1, text: 'signal x:bool\nconnect x->y\n' },
  });
  let d = await client.waitForDiagnostics(u);
  assert.equal(d.length, 1);
  assert.match(d[0].message, /Unknown signal 'y'/);

  client.notifications = [];
  client.notify('textDocument/didChange', {
    textDocument: { uri: u, version: 2 },
    contentChanges: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'signal y:bool\n' },
    ],
  });
  d = await client.waitForDiagnostics(u);
  assert.equal(d.length, 0);

  // stale version must be ignored
  client.notify('textDocument/didChange', {
    textDocument: { uri: u, version: 2 },
    contentChanges: [{ text: 'garbage!!!' }],
  });
  client.notify('textDocument/didChange', {
    textDocument: { uri: u, version: 3 },
    contentChanges: [
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, text: 'connect x->z\n' },
    ],
  });
  client.notifications = [];
  d = await client.waitForDiagnostics(u);
  assert.equal(d.length, 1);
  assert.match(d[0].message, /Unknown signal 'z'/);

  client.notify('textDocument/didClose', { textDocument: { uri: u } });
});

test('definition, references and rename over the protocol', async () => {
  const links = uri('links.sig');
  const def = await client.request('textDocument/definition', {
    textDocument: { uri: links },
    position: { line: 0, character: 9 },
  });
  assert.equal(def.uri, uri('signals.sig'));
  assert.deepEqual(def.range.start, { line: 1, character: 7 });

  const refs = await client.request('textDocument/references', {
    textDocument: { uri: links },
    position: { line: 0, character: 9 },
    context: { includeDeclaration: true },
  });
  assert.equal(refs.length, 2);

  const edit = await client.request('textDocument/rename', {
    textDocument: { uri: links },
    position: { line: 0, character: 9 },
    newName: 'velocity',
  });
  assert.equal(edit.documentChanges.length, 2);
  const uris = edit.documentChanges.map((c) => c.textDocument.uri).sort();
  assert.deepEqual(uris, [links, uri('signals.sig')].sort());

  await assert.rejects(
    client.request('textDocument/rename', {
      textDocument: { uri: links },
      position: { line: 0, character: 9 },
      newName: 'ready',
    }),
    /already exists/,
  );
});

test('watched file changes refresh diagnostics', async () => {
  const links = uri('links.sig');
  fs.writeFileSync(path.join(dir, 'links.sig'), 'connect speed->speed\n');
  client.notify('workspace/didChangeWatchedFiles', {
    changes: [{ uri: links, type: 2 }],
  });
  client.notifications = [];
  const d = await client.waitForDiagnostics(links);
  assert.equal(d.length, 0);
});
