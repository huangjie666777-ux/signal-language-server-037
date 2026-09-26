import {
  createConnection,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeWatchedFilesNotification,
  PublishDiagnosticsParams,
  ResponseError,
  ErrorCodes,
} from 'vscode-languageserver/node';
import { Workspace } from './workspace';

const connection = createConnection(ProposedFeatures.all);

let workspace: Workspace = new Workspace(null);

function log(message: string): void {
  // window/logMessage travels inside the protocol; stdout stays clean.
  connection.console.log(message);
}

function publishDiagnostics(): void {
  for (const [uri, diagnostics] of workspace.getDiagnostics()) {
    const params: PublishDiagnosticsParams = { uri, diagnostics };
    connection.sendDiagnostics(params);
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const rootUri =
    params.workspaceFolders?.[0]?.uri ??
    params.rootUri ??
    (params.rootPath ? `file://${params.rootPath}` : null);
  workspace = new Workspace(rootUri);
  workspace.loadFromDisk();
  log(`sig-lsp initialized, root: ${rootUri ?? '<none>'}`);
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: true },
      },
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: true,
    },
  };
});

connection.onInitialized(() => {
  publishDiagnostics();
  connection.client
    .register(DidChangeWatchedFilesNotification.type, {
      watchers: [{ globPattern: '**/*.sig' }],
    })
    .then(
      () => log('Registered file watchers for **/*.sig'),
      () => log('Client does not support dynamic file watcher registration.'),
    );
});

connection.onDidOpenTextDocument((params) => {
  if (!params.textDocument.uri.endsWith('.sig')) return;
  workspace.didOpen(
    params.textDocument.uri,
    params.textDocument.text,
    params.textDocument.version,
  );
  publishDiagnostics();
});

connection.onDidChangeTextDocument((params) => {
  const changed = workspace.didChange(
    params.textDocument.uri,
    params.textDocument.version,
    params.contentChanges,
  );
  if (changed) publishDiagnostics();
});

connection.onDidSaveTextDocument((params) => {
  workspace.didSave(params.textDocument.uri, params.text);
  publishDiagnostics();
});

connection.onDidCloseTextDocument((params) => {
  workspace.didClose(params.textDocument.uri);
  publishDiagnostics();
});

connection.onDidChangeWatchedFiles((params) => {
  workspace.handleWatchedFiles(params.changes);
  publishDiagnostics();
});

connection.onDefinition((params) => {
  return workspace.definition(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
  );
});

connection.onReferences((params) => {
  return workspace.references(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
  );
});

connection.onRenameRequest((params) => {
  try {
    const documentChanges = workspace.rename(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
      params.newName,
    );
    return { documentChanges };
  } catch (err) {
    throw new ResponseError(
      ErrorCodes.InvalidParams,
      err instanceof Error ? err.message : String(err),
    );
  }
});

connection.listen();
