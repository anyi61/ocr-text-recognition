/**
 * Pure helpers shared by the background service worker and Node tests.
 */
(function initBackgroundCore(globalScope) {
  const LANGUAGE_INSTRUCTIONS = Object.freeze({
    zh: '优先识别中文，并保留原文中的标点、换行和段落结构。',
    en: 'Recognize English text and preserve the original punctuation, line breaks, and paragraph structure.',
    ja: '日本語の文字を優先して認識し、句読点、改行、段落構造を維持してください。',
    ko: '한국어 텍스트를 우선 인식하고 원문의 문장 부호, 줄바꿈 및 단락 구조를 유지하세요.'
  });

  const BAIDU_LANGUAGE_TYPES = Object.freeze({
    auto: 'CHN_ENG',
    zh: 'CHN_ENG',
    en: 'ENG',
    ja: 'JAP',
    ko: 'KOR'
  });

  function buildRecognitionPrompt(prompt, language = 'auto') {
    const basePrompt = String(prompt || '').trim()
      || '请识别图片中的文字内容，只返回识别到的纯文字，不要添加任何解释或额外说明。';
    const instruction = LANGUAGE_INSTRUCTIONS[language];
    return instruction ? `${basePrompt}\n\n${instruction}` : basePrompt;
  }

  function getBaiduLanguageType(language = 'auto') {
    return BAIDU_LANGUAGE_TYPES[language] || BAIDU_LANGUAGE_TYPES.auto;
  }

  function createCredentialFingerprint(apiKey, secret = '') {
    // A cache key only: it keeps credentials out of Map inspection and logs.
    const input = `${apiKey || ''}\u0000${secret || ''}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return `credentials-${(hash >>> 0).toString(16)}`;
  }

  function createRequestRegistry() {
    const controllers = new Map();

    return {
      start(requestId) {
        if (!requestId) {
          throw new Error('缺少OCR请求ID');
        }
        const previous = controllers.get(requestId);
        if (previous) {
          previous.abort();
        }
        const controller = new AbortController();
        controllers.set(requestId, controller);
        return controller;
      },

      cancel(requestId) {
        const controller = controllers.get(requestId);
        if (!controller) return false;
        controller.abort();
        controllers.delete(requestId);
        return true;
      },

      finish(requestId, controller) {
        if (controllers.get(requestId) !== controller) {
          return false;
        }
        return controllers.delete(requestId);
      },

      has(requestId) {
        return controllers.has(requestId);
      }
    };
  }

  function isAbortError(error) {
    return error?.name === 'AbortError';
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) {
      throw new DOMException('OCR request cancelled', 'AbortError');
    }
  }

  function isSameTabIdentity(senderTab, activeTab) {
    return Number.isInteger(senderTab?.id)
      && Number.isInteger(activeTab?.id)
      && senderTab.id === activeTab.id;
  }

  function createCodedError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function extractClaudeText(data) {
    return (Array.isArray(data?.content) ? data.content : [])
      .filter((block) => typeof block?.text === 'string'
        && (!block.type || block.type === 'text'))
      .map((block) => block.text)
      .join('\n');
  }

  function assertOcrResponseComplete(provider, data) {
    const claudeTruncated = provider === 'claude' && data?.stop_reason === 'max_tokens';
    const chatTruncated = data?.choices?.some((choice) => choice?.finish_reason === 'length');
    const responsesTruncated = data?.status === 'incomplete'
      && data?.incomplete_details?.reason === 'max_output_tokens';
    if (claudeTruncated || chatTruncated || responsesTruncated) {
      throw createCodedError('OCR_RESULT_TRUNCATED', 'OCR response was truncated');
    }
  }

  function sanitizeSourceUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
      if (url.protocol === 'file:') return 'file://';
      return '';
    } catch {
      return '';
    }
  }

  function shouldPersistHistory(senderTab) {
    return senderTab?.incognito !== true;
  }

  async function appendHistoryBestEffort(store, record, signal) {
    try {
      const historyRecord = await store.append(record, signal);
      throwIfAborted(signal);
      return { historyId: historyRecord.id };
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      return { historyId: null, warningCode: 'HISTORY_SAVE_FAILED' };
    }
  }

  const api = {
    LANGUAGE_INSTRUCTIONS,
    buildRecognitionPrompt,
    getBaiduLanguageType,
    createCredentialFingerprint,
    createRequestRegistry,
    isAbortError,
    throwIfAborted,
    isSameTabIdentity,
    createCodedError,
    extractClaudeText,
    assertOcrResponseComplete,
    sanitizeSourceUrl,
    shouldPersistHistory,
    appendHistoryBestEffort
  };

  globalScope.OCRBackgroundCore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
