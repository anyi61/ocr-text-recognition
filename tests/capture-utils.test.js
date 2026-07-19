const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRequestId,
  computeCropScale
} = require('../capture-utils.js');

test('createRequestId returns a non-empty unique string', () => {
  const ids = new Set(Array.from({ length: 100 }, () => createRequestId()));

  assert.equal(ids.size, 100);
  for (const id of ids) {
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  }
});

test('computeCropScale calculates each axis independently', () => {
  assert.deepEqual(
    computeCropScale(3000, 1200, 1500, 800),
    { x: 2, y: 1.5 }
  );
});

test('computeCropScale supports fractional screenshot scaling', () => {
  assert.deepEqual(
    computeCropScale(1280, 720, 1920, 1080),
    { x: 2 / 3, y: 2 / 3 }
  );
});

test('computeCropScale rejects invalid dimensions', () => {
  assert.throws(
    () => computeCropScale(100, 100, 0, 100),
    /positive finite numbers/
  );
  assert.throws(
    () => computeCropScale(Number.NaN, 100, 100, 100),
    /positive finite numbers/
  );
});
