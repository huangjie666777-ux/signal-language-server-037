# Signal language server (sig-lsp)

LSP 3.17 server over stdio for `.sig` device-signal files, built on
`vscode-languageserver` 9.0.1 (TypeScript 5.8.3).

## Language

One statement per line; blank lines and lines starting with `#` are ignored.
Whitespace is allowed between tokens. Both LF and CRLF files are supported.

```
signal ready:bool
signal speed : number
connect speed->motor
```

Names match `[A-Za-z_][A-Za-z0-9_]*`. Declarations are globally visible
across the workspace and order independent; the two ends of a `connect`
must be declared with the same type.

## Features

- Recursive scan of `.sig` files under the single workspace root.
- Diagnostics: syntax errors, duplicate declarations, unknown names and
  connect type mismatches, all with accurate identifier ranges. Broken lines
  never abort analysis of the remaining lines.
- Unsaved buffers win over disk; incremental sync with UTF-16 positions,
  multi-edit notifications applied in order, non-increasing versions ignored.
  Closing a document falls back to the on-disk content; external
  create/change/delete events are handled via `workspace/didChangeWatchedFiles`.
- Go to definition, find references and rename. Only identifier tokens are
  considered (never comments or substrings); undeclared names never guess a
  declaration. Rename validates the new name, rejects global conflicts and
  returns a `WorkspaceEdit` (open documents carry their current version);
  the server never writes to disk itself.
- Logs go through `window/logMessage`; stdout carries protocol frames only.

## Build, test, run

```sh
npm ci
npm run build     # emits dist/server.js
npm test          # unit + stdio integration tests
npm start         # node dist/server.js --stdio
```

## Demo

`examples/workspace` contains a multi-file project (including a deliberate
type mismatch in `sub/alarms.sig`). `examples/client-demo.mjs` is a minimal
protocol client that initializes the server, prints diagnostics and
exercises definition / references / rename:

```sh
node examples/client-demo.mjs
```

## Editor integration

Any LSP-capable editor can launch `node dist/server.js --stdio` for `*.sig`
files. VS Code client sketch (`vscode-languageclient`):

```js
const serverOptions = { command: 'node', args: ['<repo>/dist/server.js', '--stdio'] };
const clientOptions = {
  documentSelector: [{ scheme: 'file', pattern: '**/*.sig' }],
  synchronize: { fileEvents: workspace.createFileSystemWatcher('**/*.sig') },
};
new LanguageClient('sig-lsp', 'Signal language server', serverOptions, clientOptions).start();
```

For Neovim:

```lua
vim.lsp.start({ name = 'sig-lsp', cmd = { 'node', '<repo>/dist/server.js', '--stdio' } })
```

Register `*.sig` as a recognized file type in your editor so the server
attaches to it.
