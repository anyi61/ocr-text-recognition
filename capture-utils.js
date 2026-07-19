/**
 * Shared helpers for the capture flow.
 *
 * The module is exposed as a browser global for the extension and as a
 * CommonJS export for the Node test suite.
 */
(function initCaptureUtils(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.OCRCaptureUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCaptureUtils() {
  /**
   * Create an opaque identifier for one OCR request.
   *
   * @returns {string}
   */
  function createRequestId() {
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === 'function'
    ) {
      return globalThis.crypto.randomUUID();
    }

    const randomPart = Math.random().toString(36).slice(2);
    return `ocr-${Date.now().toString(36)}-${randomPart}`;
  }

  /**
   * Calculate independent screenshot-to-viewport scale factors.
   *
   * Browser screenshots can be scaled differently from CSS pixels. Deriving
   * both axes from the decoded image avoids assumptions about devicePixelRatio.
   *
   * @param {number} imageWidth
   * @param {number} imageHeight
   * @param {number} viewportWidth
   * @param {number} viewportHeight
   * @returns {{x: number, y: number}}
   */
  function computeCropScale(imageWidth, imageHeight, viewportWidth, viewportHeight) {
    const dimensions = [imageWidth, imageHeight, viewportWidth, viewportHeight];
    if (dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new TypeError('Image and viewport dimensions must be positive finite numbers');
    }

    return {
      x: imageWidth / viewportWidth,
      y: imageHeight / viewportHeight
    };
  }

  /**
   * Fit image dimensions within edge and pixel-count limits while preserving
   * their aspect ratio.
   *
   * @param {number} width
   * @param {number} height
   * @param {{maxEdge: number, maxPixels: number}} limits
   * @returns {{width: number, height: number, scale: number}}
   */
  function fitImageWithinLimits(width, height, limits) {
    const values = [width, height, limits?.maxEdge, limits?.maxPixels];
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new TypeError('Image dimensions and limits must be positive finite numbers');
    }

    const edgeScale = limits.maxEdge / Math.max(width, height);
    const pixelScale = Math.sqrt(limits.maxPixels / (width * height));
    const scale = Math.min(1, edgeScale, pixelScale);
    const fittedWidth = Math.max(1, Math.floor(width * scale));
    const fittedHeight = Math.max(1, Math.floor(height * scale));

    return {
      width: fittedWidth,
      height: fittedHeight,
      scale
    };
  }

  return {
    createRequestId,
    computeCropScale,
    fitImageWithinLimits
  };
});
