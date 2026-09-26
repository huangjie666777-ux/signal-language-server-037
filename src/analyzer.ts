import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseLine } from './parser';

export interface Occurrence {
  uri: string;
  name: string;
  kind: 'decl' | 'ref';
  type?: string;
  start: number;
  end: number;
}

export interface AnalysisResult {
  diagnostics: Map<string, Diagnostic[]>;
  occurrences: Occurrence[];
  declarations: Map<string, Occurrence[]>;
}

interface ConnectPair {
  left: Occurrence;
  right: Occurrence;
}

function rangeOf(doc: TextDocument, start: number, end: number): Range {
  return Range.create(doc.positionAt(start), doc.positionAt(end));
}

export function analyze(docs: Map<string, TextDocument>): AnalysisResult {
  const diagnostics = new Map<string, Diagnostic[]>();
  const occurrences: Occurrence[] = [];
  const declarations = new Map<string, Occurrence[]>();
  const connects: ConnectPair[] = [];

  const pushDiag = (uri: string, d: Diagnostic) => {
    const list = diagnostics.get(uri) ?? [];
    list.push(d);
    diagnostics.set(uri, list);
  };

  for (const [uri, doc] of docs) {
    const text = doc.getText();
    const lines = text.split(/\r\n|\r|\n/);
    let offset = 0;
    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed.kind === 'error') {
        pushDiag(uri, {
          range: rangeOf(doc, offset + parsed.start, offset + parsed.end),
          severity: DiagnosticSeverity.Error,
          source: 'sig',
          message: parsed.message,
        });
      } else if (parsed.kind === 'decl') {
        const occ: Occurrence = {
          uri,
          name: parsed.name.text,
          kind: 'decl',
          type: parsed.type.text,
          start: offset + parsed.name.start,
          end: offset + parsed.name.end,
        };
        occurrences.push(occ);
        const list = declarations.get(occ.name) ?? [];
        list.push(occ);
        declarations.set(occ.name, list);
      } else if (parsed.kind === 'connect') {
        const left: Occurrence = {
          uri,
          name: parsed.left.text,
          kind: 'ref',
          start: offset + parsed.left.start,
          end: offset + parsed.left.end,
        };
        const right: Occurrence = {
          uri,
          name: parsed.right.text,
          kind: 'ref',
          start: offset + parsed.right.start,
          end: offset + parsed.right.end,
        };
        occurrences.push(left, right);
        connects.push({ left, right });
      }
      offset += line.length;
      if (text[offset] === '\r' && text[offset + 1] === '\n') offset += 2;
      else if (text[offset] === '\n' || text[offset] === '\r') offset += 1;
    }
  }

  for (const [name, decls] of declarations) {
    if (decls.length > 1) {
      for (const decl of decls) {
        const doc = docs.get(decl.uri)!;
        pushDiag(decl.uri, {
          range: rangeOf(doc, decl.start, decl.end),
          severity: DiagnosticSeverity.Error,
          source: 'sig',
          message: `Duplicate declaration of signal '${name}'`,
        });
      }
    }
  }

  for (const { left, right } of connects) {
    const leftDecls = declarations.get(left.name);
    const rightDecls = declarations.get(right.name);
    const leftDoc = docs.get(left.uri)!;
    const rightDoc = docs.get(right.uri)!;
    if (!leftDecls) {
      pushDiag(left.uri, {
        range: rangeOf(leftDoc, left.start, left.end),
        severity: DiagnosticSeverity.Error,
        source: 'sig',
        message: `Unknown signal '${left.name}'`,
      });
    }
    if (!rightDecls) {
      pushDiag(right.uri, {
        range: rangeOf(rightDoc, right.start, right.end),
        severity: DiagnosticSeverity.Error,
        source: 'sig',
        message: `Unknown signal '${right.name}'`,
      });
    }
    if (
      leftDecls && rightDecls &&
      leftDecls.length === 1 && rightDecls.length === 1 &&
      leftDecls[0].type !== rightDecls[0].type
    ) {
      pushDiag(right.uri, {
        range: rangeOf(rightDoc, right.start, right.end),
        severity: DiagnosticSeverity.Error,
        source: 'sig',
        message: `Type mismatch: '${left.name}' is ${leftDecls[0].type} but '${right.name}' is ${rightDecls[0].type}`,
      });
    }
  }

  return { diagnostics, occurrences, declarations };
}

