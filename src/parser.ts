export interface Token {
  text: string;
  line: number;
  /** UTF-16 column, inclusive */
  start: number;
  /** UTF-16 column, exclusive */
  end: number;
}

export interface SignalDecl {
  kind: 'signal';
  name: Token;
  type: Token;
}

export interface ConnectStmt {
  kind: 'connect';
  from: Token;
  to: Token;
}

export interface DiagnosticInfo {
  message: string;
  line: number;
  start: number;
  end: number;
}

export interface NameOccurrence {
  token: Token;
  role: 'declaration' | 'reference';
}

export interface ParseResult {
  decls: SignalDecl[];
  connects: ConnectStmt[];
  occurrences: NameOccurrence[];
  diagnostics: DiagnosticInfo[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const KEYWORDS = new Set(['signal', 'connect']);

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface RawToken extends Token {}

function tokenizeLine(lineText: string, line: number, errors: DiagnosticInfo[]): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  while (i < lineText.length) {
    const ch = lineText[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === ':') {
      tokens.push({ text: ':', line, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '-' && lineText[i + 1] === '>') {
      tokens.push({ text: '->', line, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    const m = IDENT.exec(lineText.slice(i));
    if (m) {
      tokens.push({ text: m[0], line, start: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    errors.push({
      message: `Unexpected character '${ch}'.`,
      line,
      start: i,
      end: i + 1,
    });
    return [];
  }
  return tokens;
}

function lineRange(lineText: string, line: number): DiagnosticInfo {
  let start = 0;
  while (start < lineText.length && (lineText[start] === ' ' || lineText[start] === '\t')) start++;
  let end = lineText.length;
  if (end === start) end = start + 1;
  return { message: '', line, start, end };
}

function parseLine(lineText: string, line: number, result: ParseResult): void {
  const trimmed = lineText.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return;

  const tokens = tokenizeLine(lineText, line, result.diagnostics);
  if (tokens.length === 0) {
    if (trimmed !== '' && result.diagnostics.every((d) => d.line !== line)) {
      const r = lineRange(lineText, line);
      result.diagnostics.push({ ...r, message: 'Invalid statement.' });
    }
    return;
  }

  const head = tokens[0];
  const err = (message: string, token?: Token) => {
    const r = token ?? lineRange(lineText, line);
    result.diagnostics.push({
      message,
      line: r.line,
      start: r.start,
      end: r.end,
    });
  };

  if (head.text === 'signal') {
    if (tokens.length !== 4 || tokens[2].text !== ':') {
      err("Expected 'signal <name> : <type>'.");
      return;
    }
    const name = tokens[1];
    const type = tokens[3];
    if (KEYWORDS.has(name.text) || name.text === ':' || name.text === '->') {
      err('Invalid signal name.', name);
      return;
    }
    if (KEYWORDS.has(type.text) || type.text === ':' || type.text === '->') {
      err('Invalid type name.', type);
      return;
    }
    result.decls.push({ kind: 'signal', name, type });
    result.occurrences.push({ token: name, role: 'declaration' });
    return;
  }

  if (head.text === 'connect') {
    if (tokens.length !== 4 || tokens[2].text !== '->') {
      err("Expected 'connect <from> -> <to>'.");
      return;
    }
    const from = tokens[1];
    const to = tokens[3];
    for (const t of [from, to]) {
      if (KEYWORDS.has(t.text) || t.text === ':' || t.text === '->') {
        err('Invalid signal name.', t);
        return;
      }
    }
    result.connects.push({ kind: 'connect', from, to });
    result.occurrences.push({ token: from, role: 'reference' });
    result.occurrences.push({ token: to, role: 'reference' });
    return;
  }

  err(`Unknown statement '${head.text}'; expected 'signal' or 'connect'.`, head);
}

export function parse(text: string): ParseResult {
  const result: ParseResult = { decls: [], connects: [], occurrences: [], diagnostics: [] };
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    parseLine(lines[i], i, result);
  }
  return result;
}
