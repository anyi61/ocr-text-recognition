const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRequestId,
  computeCropScale,
  fitImageWithinLimits,
  resizeSelectionRect
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

test('fitImageWithinLimits preserves small images', () => {
  assert.deepEqual(
    fitImageWithinLimits(1200, 800, { maxEdge: 4096, maxPixels: 12_000_000 }),
    { width: 1200, height: 800, scale: 1 }
  );
});

test('fitImageWithinLimits scales high-DPI captures', () => {
  const result = fitImageWithinLimits(6000, 4000, {
    maxEdge: 4096,
    maxPixels: 12_000_000
  });

  assert.ok(result.width <= 4096);
  assert.ok(result.height <= 4096);
  assert.ok(result.width * result.height <= 12_000_000);
  assert.ok(result.scale < 1);
});

test('fitImageWithinLimits rejects invalid dimensions and limits', () => {
  assert.throws(
    () => fitImageWithinLimits(0, 800, { maxEdge: 4096, maxPixels: 12_000_000 }),
    /positive finite numbers/
  );
  assert.throws(
    () => fitImageWithinLimits(1200, 800, { maxEdge: 0, maxPixels: 12_000_000 }),
    /positive finite numbers/
  );
});

test('west resize clamps to the viewport without changing the fixed right edge', () => {
  assert.deepEqual(
    resizeSelectionRect(
      { left: 100, top: 50, width: 200, height: 100 },
      'w',
      -200,
      0,
      { width: 1000, height: 700 },
      5
    ),
    { left: 0, top: 50, width: 300, height: 100 }
  );
});

test('northwest resize keeps right and bottom anchors while clamping both axes', () => {
  assert.deepEqual(
    resizeSelectionRect(
      { left: 80, top: 60, width: 220, height: 140 },
      'nw',
      -200,
      -100,
      { width: 1000, height: 700 },
      5
    ),
    { left: 0, top: 0, width: 300, height: 200 }
  );
});

test('east and south resize remain inside the viewport', () => {
  assert.deepEqual(
    resizeSelectionRect(
      { left: 900, top: 650, width: 80, height: 40 },
      'se',
      200,
      200,
      { width: 1000, height: 700 },
      5
    ),
    { left: 900, top: 650, width: 100, height: 50 }
  );
});
