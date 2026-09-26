'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { LspClient } = require('../scripts/lsp-client');

const serverPath = path.resolve(__dirname, '..', 'dist', 'index.js');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-lsp-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'main.sig'), 'signal alpha: bool\nsignal beta: number\nconnect beta -> gamma\n');
  fs.writeFileSync(path.join(dir, 'sub', 'other.sig'), 'signal gamma: number\nconnect gamma -> alpha\n');
  return dir;
}

async function startServer(rootDir) {
  const client = new LspClient(process.execPath, [serverPath]);
  const diagnostics = new Map();
  const waiters = [];
  client.onNotification('textDocument/publishDiagnostics', (params) => {
    diagnostics.set(params.uri, params.diagnostics);
    for (const waiter of [...waiters]) waiter();
  });
  const waitForDiag = (uri, predicate, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const current = diagnostics.get(uri) ?? [];
        if (predicate(current)) return resolve(current);
        if (Date.now() - started > timeoutMs) {
          return reject(new Error('timed out waiting for diagnostics of ' + uri));
        }
        waiters.push(check);
      };
      check();
    });
  const rootUri = pathToFileURL(rootDir).href;
  await client.request('initialize', {
    processId: process.pid,
    rootUri,
    capabilities: {},
  });
  client.notify('initialized', {});
  return { client, diagnostics, waitForDiag, rootUri };
}

test('LSP server end to end', async (t) => {
  const rootDir = makeWorkspace();
  const { client, waitForDiag, rootUri } = await startServer(rootDir);
  const mainUri = rootUri + '/main.sig';
  const otherUri = rootUri + '/sub/other.sig';

  await t.test('publishes diagnostics from the initial workspace scan', async () => {
    const diags = await waitForDiag(otherUri, (d) => d.length === 1);
    assert.match(diags[0].message, /Type mismatch/);
    assert.deepEqual(diags[0].range, {
      start: { line: 1, character: 17 },
      end: { line: 1, character: 22 },
    });
  });

  await t.test('unsaved buffer overrides disk and clears after fix', async () => {
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: mainUri,
        languageId: 'sig',
        version: 1,
        text: 'signal alpha: bool\r\nsignal beta: number\r\nconnect beta -> gam\r\n',
      },
    });
    const bad = await waitForDiag(mainUri, (d) => d.length === 1);
    assert.match(bad[0].message, /Unknown signal 'gam'/);
    assert.deepEqual(bad[0].range, {
      start: { line: 2, character: 16 },
      end: { line: 2, character: 19 },
    });

    // Incremental fix, UTF-16 positions on a CRLF document.
    client.notify('textDocument/didChange', {
      textDocument: { uri: mainUri, version: 2 },
      contentChanges: [
        { range: { start: { line: 2, character: 19 }, end: { line: 2, character: 19 } }, text: 'ma' },
      ],
    });
    await waitForDiag(mainUri, (d) => d.length === 0);
  });

  await t.test('stale versions are ignored', async () => {
    client.notify('textDocument/didChange', {
      textDocument: { uri: mainUri, version: 2 },
      contentChanges: [{ text: 'signal broken' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const def = await client.request('textDocument/definition', {
      textDocument: { uri: mainUri },
      position: { line: 2, character: 17 },
    });
    assert.ok(Array.isArray(def));
    assert.equal(def[0].uri, otherUri);
  });

  await t.test('definition and references resolve across files', async () => {
    const refs = await client.request('textDocument/references', {
      textDocument: { uri: mainUri },
      position: { line: 0, character: 8 },
      context: { includeDeclaration: true },
    });
    assert.equal(refs.length, 2); // decl in main.sig + ref in other.sig
  });

  await t.test('rename produces a versioned workspace edit', async () => {
    const edit = await client.request('textDocument/rename', {
      textDocument: { uri: mainUri },
      position: { line: 0, character: 8 },
      newName: 'alpha2',
    });
    const changes = edit.documentChanges;
    assert.equal(changes.length, 2);
    const forMain = changes.find((c) => c.textDocument.uri === mainUri);
    const forOther = changes.find((c) => c.textDocument.uri === otherUri);
    assert.equal(forMain.textDocument.version, 2); // open doc carries current version
    assert.equal(forOther.textDocument.version, null); // disk file unversioned
    assert.equal(forMain.edits.length + forOther.edits.length, 2);
  });

  await t.test('rename rejects invalid and conflicting names', async () => {
    await assert.rejects(
      client.request('textDocument/rename', {
        textDocument: { uri: mainUri },
        position: { line: 0, character: 8 },
        newName: '1bad',
      }),
      /Invalid signal name/,
    );
    await assert.rejects(
      client.request('textDocument/rename', {
        textDocument: { uri: mainUri },
        position: { line: 0, character: 8 },
        newName: 'beta',
      }),
      /already in use/,
    );
  });

  await t.test('closing reverts to disk content', async () => {
    client.notify('textDocument/didChange', {
      textDocument: { uri: mainUri, version: 3 },
      contentChanges: [
        { range: { start: { line: 2, character: 16 }, end: { line: 2, character: 21 } }, text: 'nope' },
      ],
    });
    await waitForDiag(mainUri, (d) => d.length === 1);
    client.notify('textDocument/didClose', { textDocument: { uri: mainUri } });
    await waitForDiag(mainUri, (d) => d.length === 0); // disk main.sig is clean
  });

  await t.test('external file changes are picked up', async () => {
    fs.writeFileSync(path.join(rootDir, 'sub', 'other.sig'), 'signal gamma: bool\nconnect gamma -> missing\n');
    client.notify('workspace/didChangeWatchedFiles', {
      changes: [{ uri: otherUri, type: 2 }],
    });
    const diags = await waitForDiag(otherUri, (d) => d.length === 1 && /missing/.test(d[0]?.message ?? ''));
    assert.match(diags[0].message, /Unknown signal 'missing'/);

    client.notify('workspace/didChangeWatchedFiles', {
      changes: [{ uri: otherUri, type: 3 }],
    });
    await waitForDiag(otherUri, (d) => d.length === 0);
  });

  await t.test('shutdown and exit succeed', async () => {
    await client.request('shutdown');
    client.notify('exit');
    await new Promise((resolve) => client.child.once('exit', resolve));
  });
});
