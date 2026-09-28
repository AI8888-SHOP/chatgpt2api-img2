const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/store/image-conversations.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const sandbox = {
  exports: {},
  require(name) {
    if (name === 'localforage') return { default: { createInstance: () => ({}) } };
    if (name === '@/lib/request') return {};
    throw new Error(`Unexpected import: ${name}`);
  },
};
vm.runInNewContext(compiled.outputText, sandbox);
const { getImageThreadId, getImageThreadTurns, getImageThreadSummaries } = sandbox.exports;
const original = { id: 'a', title: 'First prompt', createdAt: '2026-01-01T00:00:00Z', images: [] };
const followup = { id: 'b', threadId: 'a', title: 'Followup', createdAt: '2026-01-01T00:02:00Z', images: [] };
const separate = { id: 'c', title: 'Separate', createdAt: '2026-01-01T00:01:00Z', images: [] };

test('legacy records are roots, reused inputs stay in their original thread', () => {
  assert.equal(getImageThreadId(original), 'a');
  assert.equal(getImageThreadId(followup), 'a');
  const records = [followup, separate, original];
  const turns = getImageThreadTurns(records, 'a');
  assert.equal(turns.map(turn => turn.id).join(','), 'a,b');
  assert.equal(records[0], followup);
});

test('sidebar groups rounds once and retains original title with newest activity', () => {
  const summaries = getImageThreadSummaries([original, separate, followup]);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].id, 'a');
  assert.equal(summaries[0].title, 'First prompt');
  assert.equal(summaries[0].createdAt, followup.createdAt);
  assert.equal(getImageThreadTurns([original, separate, followup], 'c').length, 1);
});

test('grouping survives JSON persistence and handles empty histories', () => {
  const restored = JSON.parse(JSON.stringify([followup, original]));
  assert.equal(getImageThreadSummaries(restored).length, 1);
  assert.equal(getImageThreadTurns(restored, 'a').length, 2);
  assert.equal(getImageThreadSummaries([]).length, 0);
});
