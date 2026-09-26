import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, ParseResult, Token, NAME_PATTERN } from './parser';
import {
  DocState,
  applyDidChange,
  offsetAt,
  TextDocumentContentChange,
} from './documents';

export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: 1;
  source: string;
  message: string;
}

interface FileState extends DocState {
  uri: string;
  parsed: ParseResult;
}

interface Decl {
  name: string;
  type: string;
  uri: string;
  range: LspRange;
}

function tokenRange(token: Token): LspRange {
  return {
    start: { line: token.line, character: token.start },
    end: { line: token.line, character: token.end },
  };
}

export class Workspace {
  private files = new Map<string, FileState>();
  private decls = new Map<string, Decl>();
  private diagnostics = new Map<string, LspDiagnostic[]>();

  constructor(private readonly rootUri: string | null) {}

  /** Recursively loads every .sig file under the workspace root. */
  loadFromDisk(): void {
    if (!this.rootUri) return;
    const rootPath = fileURLToPath(this.rootUri);
    for (const file of this.collectSigFiles(rootPath)) {
      const uri = pathToFileURL(file).toString();
      if (!this.files.get(uri)?.open) {
        this.setDiskFile(uri);
      }
    }
    this.reanalyze();
  }

  private collectSigFiles(dir: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...this.collectSigFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.sig')) out.push(full);
    }
    return out;
  }

  private setDiskFile(uri: string): void {
    let text = '';
    try {
      text = fs.readFileSync(fileURLToPath(uri), 'utf8');
    } catch {
      this.files.delete(uri);
      return;
    }
    this.files.set(uri, { uri, text, version: null, open: false, parsed: parse(text) });
  }

  didOpen(uri: string, text: string, version: number | null): void {
    this.files.set(uri, { uri, text, version, open: true, parsed: parse(text) });
    this.reanalyze();
  }

  didChange(uri: string, version: number | null, changes: TextDocumentContentChange[]): boolean {
    const current = this.files.get(uri);
    if (!current) return false;
    const next = applyDidChange(current, version, changes);
    if (!next) return false; // stale or duplicate version: ignore
    this.files.set(uri, { ...current, ...next, parsed: parse(next.text) });
    this.reanalyze();
    return true;
  }

  didSave(uri: string, text: string | undefined): void {
    const current = this.files.get(uri);
    if (!current) return;
    if (text !== undefined && text !== current.text) {
      this.files.set(uri, { ...current, text, parsed: parse(text) });
      this.reanalyze();
    }
  }

  didClose(uri: string): void {
    this.files.delete(uri);
    // Fall back to the on-disk content.
    this.setDiskFile(uri);
    this.reanalyze();
  }

  handleWatchedFiles(changes: { uri: string; type: number }[]): void {
    for (const change of changes) {
      if (!change.uri.endsWith('.sig')) continue;
      const current = this.files.get(change.uri);
      if (current?.open) continue; // unsaved buffer wins
      if (change.type === 3) {
        this.files.delete(change.uri);
      } else {
        this.setDiskFile(change.uri);
      }
    }
    this.reanalyze();
  }

  private reanalyze(): void {
    this.decls.clear();
    const diagnostics = new Map<string, LspDiagnostic[]>();
    for (const uri of this.files.keys()) diagnostics.set(uri, []);

    const push = (uri: string, token: Token, message: string) => {
      diagnostics.get(uri)!.push({
        range: tokenRange(token),
        severity: 1,
        source: 'sig',
        message,
      });
    };

    // Pass 1: collect declarations (order independent, globally visible).
    for (const file of this.files.values()) {
      for (const decl of file.parsed.decls) {
        const existing = this.decls.get(decl.name.text);
        if (existing) {
          push(
            file.uri,
            decl.name,
            `Duplicate declaration of '${decl.name.text}' (first declared in ${this.displayName(existing.uri)}).`,
          );
        } else {
          this.decls.set(decl.name.text, {
            name: decl.name.text,
            type: decl.type.text,
            uri: file.uri,
            range: tokenRange(decl.name),
          });
        }
      }
    }

    // Pass 2: check connections.
    for (const file of this.files.values()) {
      for (const diag of file.parsed.diagnostics) {
        diagnostics.get(file.uri)!.push({
          range: {
            start: { line: diag.line, character: diag.start },
            end: { line: diag.line, character: diag.end },
          },
          severity: 1,
          source: 'sig',
          message: diag.message,
        });
      }
      for (const conn of file.parsed.connects) {
        const from = this.decls.get(conn.from.text);
        const to = this.decls.get(conn.to.text);
        if (!from) push(file.uri, conn.from, `Unknown signal '${conn.from.text}'.`);
        if (!to) push(file.uri, conn.to, `Unknown signal '${conn.to.text}'.`);
        if (from && to && from.type !== to.type) {
          push(
            file.uri,
            conn.to,
            `Type mismatch: cannot connect '${from.name}' (${from.type}) to '${to.name}' (${to.type}).`,
          );
        }
      }
    }

    this.diagnostics = diagnostics;
  }

  private displayName(uri: string): string {
    try {
      return path.basename(fileURLToPath(uri));
    } catch {
      return uri;
    }
  }

  /** Diagnostics for every known file; files without problems map to []. */
  getDiagnostics(): Map<string, LspDiagnostic[]> {
    return this.diagnostics;
  }

  getVersion(uri: string): number | null {
    return this.files.get(uri)?.version ?? null;
  }

  isOpen(uri: string): boolean {
    return this.files.get(uri)?.open ?? false;
  }

  private tokenAt(uri: string, line: number, character: number): Token | null {
    const file = this.files.get(uri);
    if (!file) return null;
    for (const occ of file.parsed.occurrences) {
      const t = occ.token;
      if (t.line === line && character >= t.start && character <= t.end) {
        return t;
      }
    }
    return null;
  }

  definition(uri: string, line: number, character: number): LspLocation | null {
    const token = this.tokenAt(uri, line, character);
    if (!token) return null;
    const decl = this.decls.get(token.text);
    if (!decl) return null; // undeclared: never guess a declaration
    return { uri: decl.uri, range: decl.range };
  }

  references(uri: string, line: number, character: number): LspLocation[] {
    const token = this.tokenAt(uri, line, character);
    if (!token) return [];
    const decl = this.decls.get(token.text);
    if (!decl) return []; // ambiguous/undeclared: no results
    const locations: LspLocation[] = [];
    for (const file of this.files.values()) {
      for (const occ of file.parsed.occurrences) {
        if (occ.token.text === decl.name) {
          locations.push({ uri: file.uri, range: tokenRange(occ.token) });
        }
      }
    }
    return locations;
  }

  validateRename(uri: string, line: number, character: number, newName: string): void {
    const token = this.tokenAt(uri, line, character);
    if (!token) throw new Error('No signal name at the given position.');
    if (!NAME_PATTERN.test(newName)) {
      throw new Error(`Invalid signal name '${newName}'.`);
    }
    if (newName === 'signal' || newName === 'connect') {
      throw new Error(`'${newName}' is a reserved keyword.`);
    }
    if (newName !== token.text && this.decls.has(newName)) {
      throw new Error(`A signal named '${newName}' already exists.`);
    }
    if (!this.decls.has(token.text)) {
      throw new Error(`Cannot rename undeclared signal '${token.text}'.`);
    }
  }

  rename(
    uri: string,
    line: number,
    character: number,
    newName: string,
  ): { textDocument: { uri: string; version: number | null }; edits: { range: LspRange; newText: string }[] }[] {
    this.validateRename(uri, line, character, newName);
    const token = this.tokenAt(uri, line, character)!;
    const edits = [];
    for (const file of this.files.values()) {
      const fileEdits = [];
      for (const occ of file.parsed.occurrences) {
        if (occ.token.text === token.text) {
          fileEdits.push({ range: tokenRange(occ.token), newText: newName });
        }
      }
      if (fileEdits.length > 0) {
        edits.push({
          textDocument: { uri: file.uri, version: file.open ? file.version : null },
          edits: fileEdits,
        });
      }
    }
    return edits;
  }

  /** Test/debug helper. */
  text(uri: string): string | undefined {
    return this.files.get(uri)?.text;
  }

  offsetAt(uri: string, line: number, character: number): number | null {
    const file = this.files.get(uri);
    return file ? offsetAt(file.text, { line, character }) : null;
  }
}
