'use strict';
// Demo: drives the sig language server end to end over stdio.
// Usage: node scripts/demo-client.js
const path = require('path');
const { pathToFileURL } = require('url');
const { LspClient } = require('./lsp-client');

const root = path.resolve(__dirname, '..', 'examples');
const rootUri = pathToFileURL(root).href;
const serverPath = path.resolve(__dirname, '..', 'dist', 'index.js');

async function main() {
  const client = new LspClient(process.execPath, [serverPath]);
  const diagnostics = new Map();
  client.onNotification('textDocument/publishDiagnostics', (params) => {
    diagnostics.set(params.uri, params.diagnostics);
    const rel = decodeURIComponent(params.uri).replace(root, 'examples');
    console.log('\n[diagnostics]', rel);
    for (const d of params.diagnostics) {
      console.log(
        '  ' + (d.range.start.line + 1) + ':' + (d.range.start.character + 1) + '  ' + d.message,
      );
    }
    if (params.diagnostics.length === 0) console.log('  (cleared)');
  });

  const init = await client.request('initialize', {
    processId: process.pid,
    rootUri,
    capabilities: {
      workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
      textDocument: { publishDiagnostics: {} },
    },
  });
  console.log('[initialize] server capabilities:', JSON.stringify(init.capabilities));
  client.notify('initialized', {});
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 1. Workspace scan diagnostics (the checked-in examples are clean).
  console.log('\n--- workspace scan complete ---');

  // 2. Open a document whose unsaved buffer introduces an unknown signal.
  const controlUri = rootUri + '/robot/control.sig';
  const unsaved = 'signal motor: number\nsignal encoder: number\nsignal ready: bool\n\nconnect ready -> status_le\n';
  client.notify('textDocument/didOpen', {
    textDocument: { uri: controlUri, languageId: 'sig', version: 1, text: unsaved },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 3. Incremental edit fixes the typo; diagnostics clear.
  client.notify('textDocument/didChange', {
    textDocument: { uri: controlUri, version: 2 },
    contentChanges: [
      {
        range: { start: { line: 4, character: 26 }, end: { line: 4, character: 26 } },
        text: 'd',
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 5. Definition of 'speed' referenced from motion.sig.
  const motionUri = rootUri + '/robot/motion.sig';
  const definition = await client.request('textDocument/definition', {
    textDocument: { uri: motionUri },
    position: { line: 4, character: 9 },
  });
  console.log('\n[definition] speed ->', JSON.stringify(definition));

  // 6. References to 'position'.
  const references = await client.request('textDocument/references', {
    textDocument: { uri: motionUri },
    position: { line: 2, character: 8 },
    context: { includeDeclaration: true },
  });
  console.log('[references] position ->', JSON.stringify(references));

  // 7. Rename 'speed' to 'velocity'.
  const rename = await client.request('textDocument/rename', {
    textDocument: { uri: motionUri },
    position: { line: 1, character: 8 },
    newName: 'velocity',
  });
  console.log('[rename] speed -> velocity:', JSON.stringify(rename, null, 2));

  // 8. Invalid rename is rejected.
  try {
    await client.request('textDocument/rename', {
      textDocument: { uri: motionUri },
      position: { line: 1, character: 8 },
      newName: '9bad',
    });
  } catch (err) {
    console.log('[rename] invalid name rejected:', err.message);
  }

  await client.stop();
  console.log('\n[exit] server shut down cleanly');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
