'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { analyze } = require('../dist/analyzer');

function docs(entries) {
  const map = new Map();
  for (const [uri, text] of Object.entries(entries)) {
    map.set(uri, TextDocument.create(uri, 'sig', 0, text));
  }
  return map;
}

test('clean workspace produces no diagnostics', () => {
  const result = analyze(docs({
    'file:///a.sig': 'signal a: bool\nconnect a -> b\n',
    'file:///b.sig': 'signal b: bool\n',
  }));
  assert.equal(result.diagnostics.size, 0);
  assert.equal(result.declarations.get('a').length, 1);
});

test('duplicate declarations are flagged on both files', () => {
  const result = analyze(docs({
    'file:///a.sig': 'signal dup: bool\n',
    'file:///b.sig': 'signal dup: number\n',
  }));
  assert.match(result.diagnostics.get('file:///a.sig')[0].message, /Duplicate/);
  assert.match(result.diagnostics.get('file:///b.sig')[0].message, /Duplicate/);
});

test('unknown references and type mismatches are flagged with ranges', () => {
  const result = analyze(docs({
    'file:///a.sig': 'signal a: bool\nsignal b: number\nconnect a -> b\nconnect a -> ghost\n',
  }));
  const diags = result.diagnostics.get('file:///a.sig');
  assert.equal(diags.length, 2);
  const mismatch = diags.find((d) => /Type mismatch/.test(d.message));
  assert.deepEqual(mismatch.range, {
    start: { line: 2, character: 13 },
    end: { line: 2, character: 14 },
  });
  const unknown = diags.find((d) => /Unknown signal 'ghost'/.test(d.message));
  assert.deepEqual(unknown.range, {
    start: { line: 3, character: 13 },
    end: { line: 3, character: 18 },
  });
});

test('handles CRLF line endings and incomplete input', () => {
  const result = analyze(docs({
    'file:///a.sig': 'signal a: bool\r\nsignal\r\nconnect a -> a\r\n',
  }));
  const diags = result.diagnostics.get('file:///a.sig');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /signal name/);
  assert.equal(diags[0].range.start.line, 1);
});

test('occurrences only cover identifier tokens', () => {
  const result = analyze(docs({
    'file:///a.sig': '# signal fake: bool\nsignal real: bool\nconnect real -> real\n',
  }));
  const names = result.occurrences.map((o) => o.name);
  assert.deepEqual(names, ['real', 'real', 'real']);
});
