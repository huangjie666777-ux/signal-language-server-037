// Minimal LSP client demo: starts the server over stdio, asks for
// definition / references / rename and prints the results.
// Usage: npm run build && node examples/client-demo.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'server.js');
const rootUri = pathToFileURL(path.join(here, 'workspace')).toString();

const proc = spawn(process.execPath, [serverPath, '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

proc.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd).toString('ascii'))[1]);
    if (buffer.length < headerEnd + 4 + len) return;
    const msg = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8'));
    buffer = buffer.slice(headerEnd + 4 + len);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      console.log('diagnostics', msg.params.uri.split('/').pop(),
        msg.params.diagnostics.map((d) => d.message));
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  }
});

function send(msg) {
  const body = JSON.stringify(msg);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

const init = await request('initialize', {
  processId: process.pid,
  rootUri,
  capabilities: {},
});
console.log('server capabilities:', JSON.stringify(init.capabilities));
notify('initialized', {});

const linksUri = rootUri + '/links.sig';

const def = await request('textDocument/definition', {
  textDocument: { uri: linksUri },
  position: { line: 1, character: 9 }, // 'speed' in 'connect speed->motor'
});
console.log('definition of speed:', def);

const refs = await request('textDocument/references', {
  textDocument: { uri: linksUri },
  position: { line: 1, character: 9 },
  context: { includeDeclaration: true },
});
console.log('references of speed:', refs);

const edit = await request('textDocument/rename', {
  textDocument: { uri: linksUri },
  position: { line: 1, character: 9 },
  newName: 'velocity',
});
console.log('rename speed -> velocity:', JSON.stringify(edit, null, 2));

try {
  await request('textDocument/rename', {
    textDocument: { uri: linksUri },
    position: { line: 1, character: 9 },
    newName: 'motor',
  });
} catch (err) {
  console.log('rename to existing name rejected:', err.message);
}

await request('shutdown');
notify('exit');
proc.once('exit', () => process.exit(0));
