import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../dist/parser.js';

test('parses declarations and connections', () => {
  const r = parse('signal ready:bool\nsignal speed : number\nconnect speed->motor\n');
  assert.equal(r.diagnostics.length, 0);
  assert.deepEqual(
    r.decls.map((d) => [d.name.text, d.type.text]),
    [['ready', 'bool'], ['speed', 'number']],
  );
  assert.equal(r.connects.length, 1);
  assert.equal(r.connects[0].from.text, 'speed');
  assert.equal(r.connects[0].to.text, 'motor');
});

test('skips blank lines and comments', () => {
  const r = parse('# comment\n\n   \nsignal a:bool\n  # indented comment\n');
  assert.equal(r.diagnostics.length, 0);
  assert.equal(r.decls.length, 1);
});

test('handles CRLF line endings', () => {
  const r = parse('signal a:bool\r\nconnect a->b\r\n');
  assert.equal(r.decls.length, 1);
  assert.equal(r.connects.length, 1);
  assert.equal(r.diagnostics.length, 0);
});

test('reports syntax error only on the broken line', () => {
  const r = parse('signal a:bool\nsignal broken\nsignal b:number\n');
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].line, 1);
  assert.equal(r.decls.length, 2);
});

test('reports unexpected characters with accurate range', () => {
  const r = parse('signal a:bool;\n');
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].start, 13);
  assert.equal(r.diagnostics[0].end, 14);
});

test('token ranges are accurate', () => {
  const r = parse('  signal   speed:number\n');
  assert.equal(r.decls[0].name.start, 11);
  assert.equal(r.decls[0].name.end, 16);
  assert.equal(r.decls[0].type.start, 17);
  assert.equal(r.decls[0].type.end, 23);
});

test('rejects keywords as names', () => {
  const r = parse('signal signal:bool\n');
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.decls.length, 0);
});
