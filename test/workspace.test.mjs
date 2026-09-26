import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Workspace } from '../dist/workspace.js';

let dir;
let rootUri;
const uri = (name) => pathToFileURL(path.join(dir, name)).toString();
const write = (name, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-ws-'));
  rootUri = pathToFileURL(dir).toString();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function diags(ws, name) {
  return ws.getDiagnostics().get(uri(name)) ?? [];
}

test('loads .sig files recursively, order independent', () => {
  write('a.sig', 'connect speed->motor\n');
  write('sub/b.sig', 'signal speed:number\nsignal motor:number\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  assert.equal(diags(ws, 'a.sig').length, 0);
  assert.equal(diags(ws, 'sub/b.sig').length, 0);
});

test('reports duplicate declarations across files', () => {
  write('a.sig', 'signal ready:bool\n');
  write('b.sig', 'signal ready:bool\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  const all = [...ws.getDiagnostics().values()].flat();
  assert.equal(all.length, 1);
  assert.match(all[0].message, /Duplicate declaration of 'ready'/);
  assert.deepEqual(all[0].range, {
    start: { line: 0, character: 7 },
    end: { line: 0, character: 12 },
  });
});

test('reports unknown names and type mismatch', () => {
  write('a.sig', 'signal speed:number\nsignal ready:bool\nconnect speed->ready\nconnect speed->ghost\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  const d = diags(ws, 'a.sig');
  assert.equal(d.length, 2);
  assert.match(d[0].message, /Type mismatch/);
  assert.deepEqual(d[0].range.start, { line: 2, character: 15 });
  assert.match(d[1].message, /Unknown signal 'ghost'/);
  assert.deepEqual(d[1].range.start, { line: 3, character: 15 });
});

test('open buffer wins over disk; close restores disk content', () => {
  write('a.sig', 'signal speed:number\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  ws.didOpen(uri('a.sig'), 'signal speed:bool\nconnect speed->ghost\n', 1);
  assert.match(diags(ws, 'a.sig')[0].message, /Unknown signal 'ghost'/);
  ws.didClose(uri('a.sig'));
  assert.equal(diags(ws, 'a.sig').length, 0);
  assert.equal(ws.text(uri('a.sig')), 'signal speed:number\n');
});

test('stale didChange versions are ignored', () => {
  write('a.sig', 'signal a:bool\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  ws.didOpen(uri('a.sig'), 'signal a:bool\n', 1);
  ws.didChange(uri('a.sig'), 2, [{ text: 'signal b:bool\n' }]);
  ws.didChange(uri('a.sig'), 2, [{ text: 'signal c:bool\n' }]); // duplicate version
  ws.didChange(uri('a.sig'), 1, [{ text: 'signal d:bool\n' }]); // stale
  assert.equal(ws.text(uri('a.sig')), 'signal b:bool\n');
});

test('diagnostics clear after fix and update across files', () => {
  write('a.sig', 'signal speed:number\n');
  write('b.sig', 'connect speed->motor\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  assert.equal(diags(ws, 'b.sig').length, 1); // unknown motor
  ws.didOpen(uri('a.sig'), 'signal speed:number\nsignal motor:number\n', 1);
  assert.equal(diags(ws, 'b.sig').length, 0);
});

test('watched file create/change/delete refresh analysis', () => {
  write('a.sig', 'connect x->y\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  assert.equal(diags(ws, 'a.sig').length, 2);
  write('b.sig', 'signal x:bool\nsignal y:bool\n');
  ws.handleWatchedFiles([{ uri: uri('b.sig'), type: 1 }]);
  assert.equal(diags(ws, 'a.sig').length, 0);
  fs.rmSync(path.join(dir, 'b.sig'));
  ws.handleWatchedFiles([{ uri: uri('b.sig'), type: 3 }]);
  assert.equal(diags(ws, 'a.sig').length, 2);
});

test('definition resolves across files; undeclared yields null', () => {
  write('a.sig', 'signal speed:number\n');
  write('b.sig', 'connect speed->ghost\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  const def = ws.definition(uri('b.sig'), 0, 9);
  assert.equal(def.uri, uri('a.sig'));
  assert.deepEqual(def.range.start, { line: 0, character: 7 });
  assert.equal(ws.definition(uri('b.sig'), 0, 16), null);
});

test('references include declaration and all uses, not substrings', () => {
  write('a.sig', 'signal speed:number\nsignal speed2:number\n');
  write('b.sig', 'connect speed->speed2\n# speed mention in comment\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  const refs = ws.references(uri('a.sig'), 0, 8);
  assert.equal(refs.length, 2);
  assert.ok(refs.every((r) => r.range.end.character - r.range.start.character === 5));
});

test('rename produces versioned edits across files without touching disk', () => {
  write('a.sig', 'signal speed:number\n');
  write('b.sig', 'connect speed->speed\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  ws.didOpen(uri('b.sig'), 'connect speed->speed\n', 7);
  const edit = ws.rename(uri('a.sig'), 0, 8, 'velocity');
  assert.equal(edit.length, 2);
  const forA = edit.find((e) => e.textDocument.uri === uri('a.sig'));
  const forB = edit.find((e) => e.textDocument.uri === uri('b.sig'));
  assert.equal(forA.textDocument.version, null); // not open
  assert.equal(forB.textDocument.version, 7); // open doc carries version
  assert.equal(forB.edits.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'a.sig'), 'utf8'), 'signal speed:number\n');
});

test('rename rejects invalid names and global conflicts', () => {
  write('a.sig', 'signal speed:number\nsignal motor:number\n');
  const ws = new Workspace(rootUri);
  ws.loadFromDisk();
  assert.throws(() => ws.rename(uri('a.sig'), 0, 8, '9bad'), /Invalid signal name/);
  assert.throws(() => ws.rename(uri('a.sig'), 0, 8, 'motor'), /already exists/);
  assert.throws(() => ws.rename(uri('a.sig'), 0, 8, 'signal'), /reserved/);
});
