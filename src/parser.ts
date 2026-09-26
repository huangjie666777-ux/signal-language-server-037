export interface Token {
  text: string;
  start: number;
  end: number;
}

export type ParsedLine =
  | { kind: 'empty' }
  | { kind: 'decl'; name: Token; type: Token }
  | { kind: 'connect'; left: Token; right: Token }
  | { kind: 'error'; message: string; start: number; end: number };

interface LexToken extends Token {
  kind: 'ident' | 'colon' | 'arrow' | 'bad';
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

function lex(code: string): LexToken[] {
  const tokens: LexToken[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < code.length && IDENT_PART.test(code[i])) i++;
      tokens.push({ kind: 'ident', text: code.slice(start, i), start, end: i });
      continue;
    }
    if (ch === ':') {
      tokens.push({ kind: 'colon', text: ':', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '-' && code[i + 1] === '>') {
      tokens.push({ kind: 'arrow', text: '->', start: i, end: i + 2 });
      i += 2;
      continue;
    }
    const start = i;
    i++;
    tokens.push({ kind: 'bad', text: code.slice(start, i), start, end: i });
  }
  return tokens;
}

export function parseLine(line: string): ParsedLine {
  const hash = line.indexOf('#');
  const code = hash >= 0 ? line.slice(0, hash) : line;
  const tokens = lex(code);
  if (tokens.length === 0) return { kind: 'empty' };

  const lineEnd = code.trimEnd().length;
  const fail = (message: string, start: number, end: number): ParsedLine => ({
    kind: 'error',
    message,
    start,
    end: Math.max(end, start),
  });

  const bad = tokens.find((t) => t.kind === 'bad');
  if (bad) return fail(`Unexpected character '${bad.text}'`, bad.start, bad.end);

  const first = tokens[0];
  if (first.text === 'signal') {
    if (tokens.length < 2 || tokens[1].kind !== 'ident') {
      return fail("Expected a signal name after 'signal'", first.end, lineEnd);
    }
    const name = tokens[1];
    if (tokens.length < 3 || tokens[2].kind !== 'colon') {
      return fail(`Expected ':' after signal name '${name.text}'`, name.start, name.end);
    }
    if (tokens.length < 4 || tokens[3].kind !== 'ident') {
      return fail("Expected a type after ':'", tokens[2].end, lineEnd);
    }
    const type = tokens[3];
    if (tokens.length > 4) {
      return fail(`Unexpected token '${tokens[4].text}'`, tokens[4].start, lineEnd);
    }
    return { kind: 'decl', name, type };
  }
  if (first.text === 'connect') {
    if (tokens.length < 2 || tokens[1].kind !== 'ident') {
      return fail("Expected a signal name after 'connect'", first.end, lineEnd);
    }
    const left = tokens[1];
    if (tokens.length < 3 || tokens[2].kind !== 'arrow') {
      return fail(`Expected '->' after '${left.text}'`, left.start, left.end);
    }
    if (tokens.length < 4 || tokens[3].kind !== 'ident') {
      return fail("Expected a signal name after '->'", tokens[2].end, lineEnd);
    }
    const right = tokens[3];
    if (tokens.length > 4) {
      return fail(`Unexpected token '${tokens[4].text}'`, tokens[4].start, lineEnd);
    }
    return { kind: 'connect', left, right };
  }
  return fail(`Expected 'signal' or 'connect', got '${first.text}'`, first.start, first.end);
}
