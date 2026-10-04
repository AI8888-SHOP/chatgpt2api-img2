const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/lib/datetime.ts'), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS}});
const sandbox = {exports:{}};
vm.runInNewContext(compiled.outputText, sandbox);
const {formatUtc8Time} = sandbox.exports;

test('UTC8 stays consistent across client zones and legacy/offset timestamps', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['UTC','America/Los_Angeles','Asia/Shanghai']) {
      process.env.TZ = zone;
      for (const input of ['2026-10-04T16:00:00Z','2026-10-05T00:00:00+08:00',
                           '2026-10-04 16:00:00',Date.parse('2026-10-04T16:00:00Z')/1000]) {
        assert.equal(formatUtc8Time(input), '2026-10-05 00:00:00', `${zone}: ${input}`);
      }
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});
test('missing and invalid dates render a placeholder', () => {
  for (const input of [null,undefined,'','invalid']) assert.equal(formatUtc8Time(input),'—');
});
