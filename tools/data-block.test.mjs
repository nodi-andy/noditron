import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../client/src/palette.js', import.meta.url), 'utf8');
const match = source.match(/const DATA_FN = `([\s\S]*?)`\.trim\(\);/);
assert.ok(match, 'DATA_FN source is present');
const run = new Function('inputs', 'props', 'helpers', match[1]);

test('Data in passes the live signal without changing stored data', () => {
  const result = run({ in: 'live' }, { value: false }, {});
  assert.deepEqual(result, { out: 'live' });
});

test('Data uses its stored value when in is not carrying a signal', () => {
  const result = run({}, { value: false }, {});
  assert.deepEqual(result, { out: false });
});

test('Data write changes the stored value', () => {
  const result = run({ in: 'live', write: 'saved' }, { value: false }, {});
  assert.deepEqual(result, { out: 'saved', __persist: { value: 'saved' } });
});
