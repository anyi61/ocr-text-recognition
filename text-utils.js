/** Local, opt-in text cleanup. Never changes the stored OCR result itself. */
(function initializeTextUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRTextUtils = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTextUtils() {
  'use strict';

  function mergeWrappedLines(text) {
    // Empty lines are paragraph boundaries. Only join consecutive non-empty
    // lines, retaining leading/trailing whitespace outside the joined boundary.
    return String(text ?? '').replace(/(\S)[^\S\r\n]*\r?\n[^\S\r\n]*(?=\S)/gu, (match, left, offset, source) => {
      const right = String.fromCodePoint(source.codePointAt(offset + match.length));
      const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;
      return left + (cjk.test(left) && cjk.test(right) ? '' : ' ');
    });
  }

  return Object.freeze({ mergeWrappedLines });
}));
