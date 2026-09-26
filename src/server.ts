import * as fs from 'fs';
import * as path from 'path';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import {
  createConnection,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  Location,
  ResponseError,
  ErrorCodes,
  TextDocumentEdit,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, AnalysisResult, Occurrence } from './analyzer';

interface FileState {
  doc: TextDocument;
  open: boolean;
  version: number | null;
}

const connection = createConnection(
  ProposedFeatures.all,
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const files = new Map<string, FileState>();
const publishedDiagnostics = new Set<string>();
let analysis: AnalysisResult = { diagnostics: new Map(), occurrences: [], declarations: new Map() };
let rootUri: string | null = null;
let queue: Promise<void> = Promise.resolve();

function log(message: string): void {
  console.error('[sig-lsp] ' + message);
}

function serialize(task: () => void | Promise<void>): void {
  queue = queue.then(task).catch((err) => log('task failed: ' + err));
}

function filePath(uri: string): string {
  return decodeURIComponent(new URL(uri).pathname);
}

async function readDiskFile(uri: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath(uri), 'utf8');
  } catch {
    return null;
  }
}

async function collectSigFiles(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSigFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.sig')) out.push(full);
  }
}

async function loadWorkspace(): Promise<void> {
  if (!rootUri) return;
  const paths: string[] = [];
  await collectSigFiles(filePath(rootUri), paths);
  for (const p of paths) {
    const uri = 'file://' + p;
    if (files.get(uri)?.open) continue;
    const text = await readDiskFile(uri);
    if (text === null) continue;
    files.set(uri, { doc: TextDocument.create(uri, 'sig', 0, text), open: false, version: null });
  }
}

function rebuild(): void {
  const docs = new Map<string, TextDocument>();
  for (const [uri, state] of files) docs.set(uri, state.doc);
  analysis = analyze(docs);
  const targets = new Set<string>([...publishedDiagnostics, ...analysis.diagnostics.keys()]);
  for (const uri of targets) {
    const diagnostics = analysis.diagnostics.get(uri) ?? [];
    connection.sendDiagnostics({ uri, diagnostics });
    if (diagnostics.length === 0) publishedDiagnostics.delete(uri);
    else publishedDiagnostics.add(uri);
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  rootUri = params.rootUri ?? params.workspaceFolders?.[0]?.uri ?? null;
  log('initialize rootUri=' + rootUri);
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: false },
      },
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
    },
  };
});

connection.onInitialized(() => {
  serialize(async () => {
    await loadWorkspace();
    rebuild();
    try {
      await connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [{ globPattern: '**/*.sig' }],
      });
    } catch {
      log('client does not support dynamic file watching registration');
    }
  });
});

connection.onDidOpenTextDocument((params) => {
  serialize(() => {
    const { uri, version, text } = params.textDocument;
    files.set(uri, {
      doc: TextDocument.create(uri, 'sig', version, text),
      open: true,
      version,
    });
    rebuild();
  });
});

connection.onDidChangeTextDocument((params) => {
  serialize(() => {
    const state = files.get(params.textDocument.uri);
    if (!state || !state.open) return;
    const version = params.textDocument.version;
    if (state.version !== null && version <= state.version) {
      log('ignoring stale version ' + version + ' for ' + params.textDocument.uri);
      return;
    }
    state.doc = TextDocument.update(state.doc, params.contentChanges, version);
    state.version = version;
    rebuild();
  });
});

connection.onDidSaveTextDocument(() => {
  // Open documents are already authoritative; nothing to do.
});

connection.onDidCloseTextDocument((params) => {
  serialize(async () => {
    const uri = params.textDocument.uri;
    const state = files.get(uri);
    if (!state) return;
    state.open = false;
    state.version = null;
    const disk = await readDiskFile(uri);
    if (disk === null) {
      files.delete(uri);
    } else {
      state.doc = TextDocument.create(uri, 'sig', 0, disk);
    }
    rebuild();
  });
});

connection.onDidChangeWatchedFiles((params) => {
  serialize(async () => {
    for (const change of params.changes) {
      const uri = change.uri;
      if (change.type === FileChangeType.Deleted) {
        files.delete(uri);
        continue;
      }
      const state = files.get(uri);
      if (state?.open) continue; // unsaved buffer wins
      const text = await readDiskFile(uri);
      if (text === null) {
        files.delete(uri);
      } else {
        files.set(uri, { doc: TextDocument.create(uri, 'sig', 0, text), open: false, version: null });
      }
    }
    rebuild();
  });
});

function occurrenceAt(uri: string, position: { line: number; character: number }): Occurrence | null {
  const state = files.get(uri);
  if (!state) return null;
  const offset = state.doc.offsetAt(position);
  let best: Occurrence | null = null;
  for (const occ of analysis.occurrences) {
    if (occ.uri !== uri) continue;
    if (occ.start <= offset && offset <= occ.end) {
      if (!best || occ.end - occ.start < best.end - best.start) best = occ;
    }
  }
  return best;
}

function toLocation(occ: Occurrence): Location {
  const doc = files.get(occ.uri)!.doc;
  return Location.create(occ.uri, {
    start: doc.positionAt(occ.start),
    end: doc.positionAt(occ.end),
  });
}

connection.onDefinition((params) => {
  const occ = occurrenceAt(params.textDocument.uri, params.position);
  if (!occ) return null;
  const decls = analysis.declarations.get(occ.name) ?? [];
  if (decls.length === 0) return null;
  return decls.map(toLocation);
});

connection.onReferences((params) => {
  const occ = occurrenceAt(params.textDocument.uri, params.position);
  if (!occ) return null;
  return analysis.occurrences
    .filter((o) => o.name === occ.name)
    .filter((o) => params.context.includeDeclaration || o.kind !== 'decl')
    .map(toLocation);
});

connection.onPrepareRename((params) => {
  const occ = occurrenceAt(params.textDocument.uri, params.position);
  if (!occ) return null;
  const doc = files.get(occ.uri)!.doc;
  return {
    range: { start: doc.positionAt(occ.start), end: doc.positionAt(occ.end) },
    placeholder: occ.name,
  };
});

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

connection.onRenameRequest((params): WorkspaceEdit => {
  const occ = occurrenceAt(params.textDocument.uri, params.position);
  if (!occ) {
    throw new ResponseError(ErrorCodes.InvalidParams, 'No signal name at the given position');
  }
  const newName = params.newName;
  if (!NAME_PATTERN.test(newName)) {
    throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid signal name: ' + newName);
  }
  if (analysis.occurrences.some((o) => o.name === newName)) {
    throw new ResponseError(ErrorCodes.InvalidParams, 'Signal name already in use: ' + newName);
  }
  const byUri = new Map<string, TextEdit[]>();
  for (const target of analysis.occurrences) {
    if (target.name !== occ.name) continue;
    const doc = files.get(target.uri)!.doc;
    const edit = TextEdit.replace(
      { start: doc.positionAt(target.start), end: doc.positionAt(target.end) },
      newName,
    );
    const list = byUri.get(target.uri) ?? [];
    list.push(edit);
    byUri.set(target.uri, list);
  }
  const documentChanges: TextDocumentEdit[] = [];
  for (const [uri, edits] of byUri) {
    const state = files.get(uri)!;
    documentChanges.push(
      TextDocumentEdit.create({ uri, version: state.open ? state.version : null }, edits),
    );
  }
  return { documentChanges };
});

connection.onShutdown(() => {
  log('shutdown');
});

connection.onExit(() => {
  process.exit(0);
});

connection.listen();
