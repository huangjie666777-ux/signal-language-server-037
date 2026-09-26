import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDidChange, offsetAt } from '../dist/documents.js';

test('applies incremental edits in order', () => {
  const state = { text: 'signal a:bool\n', version: 1, open: true };
  const next = applyDidChange(state, 2, [
    { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } }, text: 'ready' },
    { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 13 } }, text: ' ' },
  ]);
  assert.equal(next.text, 'signal ready: bool\n');
  assert.equal(next.version, 2);
});

test('ignores non-increasing versions', () => {
  const state = { text: 'signal a:bool\n', version: 5, open: true };
  assert.equal(applyDidChange(state, 5, [{ text: 'x' }]), null);
  assert.equal(applyDidChange(state, 3, [{ text: 'x' }]), null);
  assert.notEqual(applyDidChange(state, 6, [{ text: 'x' }]), null);
});

test('full text replacement when no range given', () => {
  const state = { text: 'old', version: 1, open: true };
  const next = applyDidChange(state, 2, [{ text: 'new' }]);
  assert.equal(next.text, 'new');
});

test('offsetAt handles CRLF', () => {
  const text = 'ab\r\ncd\r\n';
  assert.equal(offsetAt(text, { line: 1, character: 0 }), 4);
  assert.equal(offsetAt(text, { line: 0, character: 99 }), 2);
});

test('offsetAt counts UTF-16 units', () => {
  const text = '# \u4e2d\u6587\nsignal a:bool\n';
  assert.equal(offsetAt(text, { line: 1, character: 7 }), 5 + 7);
});
