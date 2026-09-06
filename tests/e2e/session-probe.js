'use strict';

// Serialized ONLY into temporary E2E extension copies. The page's main world
// cannot see this probe; production content.js and closed-shadow behavior stay intact.
function installSessionProbe() {
  if (globalThis.__ocrSessionProbe) {
    globalThis.__ocrSessionProbe.bindSessionFactory();
    return;
  }
  const sessions = [];
  let wrappedCreate;
  function bindSessionFactory() {
    if (OCRCaptureSession.create === wrappedCreate) return;
    const originalCreate = OCRCaptureSession.create;
    wrappedCreate = function(dependencies) {
      const instance = originalCreate(dependencies);
      sessions.push(instance);
      return instance;
    };
    OCRCaptureSession.create = wrappedCreate;
  }
  bindSessionFactory();
  const intervals = new Set();
  const set = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  globalThis.setInterval = (...args) => {
    const id = set(...args);
    intervals.add(id);
    return id;
  };
  globalThis.clearInterval = id => { intervals.delete(id); return clear(id); };
  const listeners = new Map();
  for (const [target, label] of [[document, 'document'], [window, 'window']]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = function(type, callback, options) {
      const key = `${label}:${type}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(callback);
      return add(type, callback, options);
    };
    target.removeEventListener = function(type, callback, options) {
      listeners.get(`${label}:${type}`)?.delete(callback);
      return remove(type, callback, options);
    };
  }
  const copied = [];
  navigator.clipboard.writeText = async text => { copied.push(text); };
  const pending = {};
  const held = {};
  const messages = [];
  const roots = [];
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  const attach = globalThis.Element.prototype.attachShadow;
  globalThis.Element.prototype.attachShadow = function(options) {
    const root = attach.call(this, options);
    if (this.id === 'ocr-root-host') roots.push(root);
    return root;
  };
  function defer(action, value, resume) {
    return new Promise((resolve, reject) => {
      (pending[action] ||= []).push({ resolve, reject, value, resume });
    });
  }
  chrome.runtime.sendMessage = function(request, ...args) {
    messages.push({ action: request.action, requestId: request.requestId });
    if (!held[request.action]) return send(request, ...args);
    if (held[request.action] === 'after') {
      return send(request, ...args).then(value => defer(request.action, value));
    }
    return defer(request.action);
  };
  const ImageClass = globalThis.Image;
  globalThis.Image = function(...args) {
    const image = new ImageClass(...args);
    Object.defineProperty(image, 'onload', {
      set(callback) {
        image.addEventListener('load', event => {
          const resume = () => callback.call(image, event);
          if (held.crop) defer('crop', undefined, resume);
          else resume();
        }, { once: true });
      }
    });
    return image;
  };
  const root = () => roots.findLast(item => item.host.isConnected);
  globalThis.__ocrSessionProbe = {
    async settle(selector) {
      const element = root()?.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    },
    copied() { return copied; },
    rect() {
      const rect = root()?.querySelector('#ocr-selection-box')?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
    },
    focused(selector) { return root()?.activeElement?.matches(selector) || false; },
    scriptCount() { return root()?.querySelectorAll('script').length || 0; },
    bindSessionFactory,
    destroy() { sessions.at(-1).destroy(); },
    lifecycle() {
      return { instances: sessions.length, intervals: intervals.size, listeners: [...listeners.values()].reduce((sum, set) => sum + set.size, 0) };
    },
    hold(action, mode = 'before') { held[action] = mode; },
    unhold(action) { delete held[action]; },
    count(action) { return (pending[action] || []).length; },
    messages() { return messages; },
    async release(action, index = 0, result = {}) {
      const item = pending[action]?.[index];
      if (!item || item.released) throw new Error(`Missing pending ${action}:${index}`);
      item.released = true;
      if (result.error) item.reject(new Error(result.error));
      else {
        item.resume?.();
        item.resolve(Object.hasOwn(result, 'value') ? result.value : item.value);
      }
      // Drain promise continuations and a paint before inspecting observable UI.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    snapshot() {
      const r = root();
      return {
        overlays: r?.querySelectorAll('#ocr-capture-overlay').length || 0,
        selections: r?.querySelectorAll('#ocr-selection-box').length || 0,
        notices: r?.querySelectorAll('.ocr-upload-notice-backdrop').length || 0,
        progress: r?.querySelectorAll('#ocr-progress-notification').length || 0,
        result: r?.querySelector('textarea')?.value || '',
        notification: r?.querySelector('.ocr-notify-msg')?.textContent || ''
      };
    },
    point(selector) {
      const element = root()?.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
  };
}

module.exports = { installSessionProbe };
