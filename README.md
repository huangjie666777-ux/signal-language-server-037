# Signal language server

LSP 3.17 server over stdio for `.sig` device-signal files.

Requires Node.js 22.19.0 and npm 10.9.3.
Dependencies are pinned in package-lock.json.

## Language

One statement per line; blank lines and `# ...` comments are allowed,
and whitespace may appear between tokens:

```
signal ready: bool      # declares a globally visible signal
signal speed: number
connect speed -> motor  # both endpoints must exist and share a type
```

Names match `[A-Za-z_][A-Za-z0-9_]*`. Declarations are global across the
workspace and order independent.

## Features

- Recursive scan of the single workspace root for `.sig` files.
- Diagnostics: syntax errors, duplicate declarations, unknown names,
  type mismatches. Unsaved buffers win over disk; closing reverts to disk.
  Incremental UTF-16 edits, LF/CRLF, stale versions ignored, and external
  file create/change/delete notifications are handled.
- Go to definition, find references, and rename (identifier-exact,
  rejects invalid/conflicting names, returns a versioned WorkspaceEdit
  without touching disk).
- Logs go to stderr only; stdout carries the protocol.

## Build, test, demo

```sh
npm ci
npm run build
npm test        # unit + end-to-end LSP tests
npm run demo    # drives the server in examples/ via scripts/demo-client.js
```

## Editor integration

Start the server with `node dist/index.js` (stdio transport) and attach it
to `.sig` files. VS Code extension example:

```js
const server = { command: 'node', args: ['/path/to/dist/index.js'] };
const client = new LanguageClient('sig', 'Signal Language Server',
  { run: server, debug: server },
  { documentSelector: [{ language: 'sig', pattern: '**/*.sig' }] });
client.start();
```

Neovim example:

```lua
vim.lsp.start({
  name = 'sig-lsp',
  cmd = { 'node', '/path/to/dist/index.js' },
  root_dir = vim.fs.root(0, '.git'),
})
```

See `examples/` for a multi-file project and `scripts/demo-client.js` for a
plain protocol client.
