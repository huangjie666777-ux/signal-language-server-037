'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine } = require('../dist/parser');

test('parses a signal declaration', () => {
  const parsed = parseLine('signal ready: bool');
  assert.equal(parsed.kind, 'decl');
  assert.equal(parsed.name.text, 'ready');
  assert.equal(parsed.type.text, 'bool');
});

test('parses a connect statement', () => {
  const parsed = parseLine('connect speed->motor');
  assert.equal(parsed.kind, 'connect');
  assert.equal(parsed.left.text, 'speed');
  assert.equal(parsed.right.text, 'motor');
});

test('tolerates extra whitespace between tokens', () => {
  const parsed = parseLine('  signal   _x9  :   number  ');
  assert.equal(parsed.kind, 'decl');
  assert.equal(parsed.name.text, '_x9');
  assert.equal(parsed.type.text, 'number');
});

test('treats blank lines and comments as empty', () => {
  assert.equal(parseLine('').kind, 'empty');
  assert.equal(parseLine('   ').kind, 'empty');
  assert.equal(parseLine('# a comment').kind, 'empty');
  assert.equal(parseLine('signal a: bool # trailing').kind, 'decl');
});

test('reports accurate error ranges', () => {
  const missing = parseLine('signal foo');
  assert.equal(missing.kind, 'error');
  assert.deepEqual([missing.start, missing.end], [7, 10]);

  const badChar = parseLine('signal 1foo: bool');
  assert.equal(badChar.kind, 'error');
  assert.deepEqual([badChar.start, badChar.end], [7, 8]);

  const unknown = parseLine('sigal a: bool');
  assert.equal(unknown.kind, 'error');
  assert.deepEqual([unknown.start, unknown.end], [0, 5]);
});

test('rejects trailing tokens', () => {
  const parsed = parseLine('connect a -> b extra');
  assert.equal(parsed.kind, 'error');
  assert.deepEqual([parsed.start, parsed.end], [15, 20]);
});
