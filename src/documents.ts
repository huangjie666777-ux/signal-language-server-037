export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface TextDocumentContentChange {
  range?: Range;
  text: string;
}

export interface DocState {
  text: string;
  version: number | null;
  open: boolean;
}

/** Offset of an LSP (UTF-16) position in the text. Clamped to the line end. */
export function offsetAt(text: string, position: Position): number {
  let offset = 0;
  let line = 0;
  while (line < position.line) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
    line++;
  }
  let lineEnd = text.indexOf('\n', offset);
  if (lineEnd === -1) lineEnd = text.length;
  if (lineEnd > offset && text[lineEnd - 1] === '\r') lineEnd--;
  return Math.min(offset + position.character, lineEnd);
}

export function applyChange(text: string, change: TextDocumentContentChange): string {
  if (!change.range) return change.text;
  const start = offsetAt(text, change.range.start);
  const end = offsetAt(text, change.range.end);
  return text.slice(0, start) + change.text + text.slice(end);
}

/**
 * Applies a didChange notification. Returns the updated state, or null when
 * the notification version is not newer than the current one and must be
 * ignored. Multiple content changes apply in order.
 */
export function applyDidChange(
  state: DocState,
  version: number | null,
  changes: TextDocumentContentChange[],
): DocState | null {
  if (
    version !== null &&
    state.version !== null &&
    version <= state.version
  ) {
    return null;
  }
  let text = state.text;
  for (const change of changes) {
    text = applyChange(text, change);
  }
  return { text, version: version ?? state.version, open: state.open };
}
