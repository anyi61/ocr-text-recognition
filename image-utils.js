/** Validate local image files before decoding, then normalize them for OCR. */
(function initImageUtils(root, factory) {
  const capture = typeof module === 'object' && module.exports ? require('./capture-utils.js') : root.OCRCaptureUtils;
  const api = factory(capture);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRImageUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createImageUtils(capture) {
  'use strict';
  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_PIXELS = 40_000_000;
  const MAX_BASE64_LENGTH = 3 * 1024 * 1024;
  const TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
  function fail(code) { const error = new Error(code); error.code = code; throw error; }
  function validateFile(file) {
    if (!file || !TYPES.includes(file.type)) fail('image_import_invalid_type');
    if (!Number.isFinite(file.size) || file.size <= 0) fail('image_import_invalid_image');
    if (file.size > MAX_BYTES) fail('image_import_too_large');
  }
  function validateDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) fail('image_import_invalid_image');
    if (width * height > MAX_PIXELS || Math.max(width, height) > 32767) fail('image_import_too_many_pixels');
    return { width, height };
  }
  function inspectImage(bytes, type) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const word = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    let width, height;
    if (type === 'image/png') {
      if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
        || word(12, 4) !== 'IHDR' || view.getUint32(8) !== 13) fail('image_import_invalid_image');
      width = view.getUint32(16); height = view.getUint32(20);
      for (let offset = 8; offset + 12 <= bytes.length;) {
        const size = view.getUint32(offset);
        if (word(offset + 4, 4) === 'acTL') fail('image_import_animated');
        if (size > bytes.length - offset - 12) fail('image_import_invalid_image');
        offset += size + 12;
      }
    } else if (type === 'image/jpeg') {
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) fail('image_import_invalid_image');
      let offset = 2;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 255) fail('image_import_invalid_image');
        while (bytes[offset] === 255) offset += 1;
        const marker = bytes[offset++];
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        if (offset + 2 > bytes.length) break;
        const size = view.getUint16(offset);
        if (size < 2 || offset + size > bytes.length) fail('image_import_invalid_image');
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
          if (size < 8) fail('image_import_invalid_image');
          height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
        }
        offset += size;
      }
    } else if (type === 'image/webp') {
      if (bytes.length < 30 || word(0, 4) !== 'RIFF' || word(8, 4) !== 'WEBP') fail('image_import_invalid_image');
      const kind = word(12, 4);
      if (kind === 'VP8X') {
        if (bytes[20] & 2) fail('image_import_animated');
        width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
        height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      } else if (kind === 'VP8L' && bytes[20] === 47) {
        width = 1 + bytes[21] + ((bytes[22] & 63) << 8);
        height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10);
      } else if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
        width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383;
      }
    } else fail('image_import_invalid_type');
    return validateDimensions(width, height);
  }
  async function normalizeFile(file) {
    validateFile(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    inspectImage(bytes, file.type);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.type }));
    const image = new Image();
    try {
      image.src = objectUrl;
      await image.decode();
      const original = validateDimensions(image.naturalWidth, image.naturalHeight);
      let fitted = capture.fitImageWithinLimits(original.width, original.height, { maxEdge: 4096, maxPixels: 12_000_000 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) fail('image_import_invalid_image');
      for (let attempt = 0; attempt < 12; attempt += 1) {
        canvas.width = fitted.width; canvas.height = fitted.height;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, fitted.width, fitted.height);
        const dataUrl = canvas.toDataURL('image/png');
        const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
        if (payload.length <= MAX_BASE64_LENGTH) return { dataUrl, ...fitted, originalWidth: original.width, originalHeight: original.height };
        const scale = Math.min(0.9, Math.sqrt(MAX_BASE64_LENGTH / payload.length) * 0.95);
        fitted = { width: Math.max(1, Math.floor(fitted.width * scale)), height: Math.max(1, Math.floor(fitted.height * scale)) };
      }
      fail('image_import_too_large');
    } catch (error) {
      if (error.code?.startsWith?.('image_import_')) throw error;
      fail('image_import_invalid_image');
    } finally {
      image.src = '';
      URL.revokeObjectURL(objectUrl);
    }
  }
  return Object.freeze({ MAX_BYTES, MAX_PIXELS, MAX_BASE64_LENGTH, TYPES, validateFile, validateDimensions, inspectImage, normalizeFile });
});
