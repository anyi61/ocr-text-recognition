const sharedGlobals = Object.fromEntries([
  'AbortController', 'Blob', 'Buffer', 'CustomEvent', 'DOMException', 'FileReader',
  'Image', 'Intl', 'KeyboardEvent', 'Map', 'Math', 'MouseEvent', 'Promise', 'Response', 'Set', 'URL',
  'URLSearchParams', 'alert', 'chrome', 'clearInterval', 'clearTimeout', 'confirm',
  'console', 'crypto', 'document', 'fetch', 'global', 'globalThis', 'importScripts', 'location', 'module',
  'navigator', 'process', 'requestAnimationFrame', 'require', 'self', 'setInterval',
  'setTimeout', 'structuredClone', 'window', '__dirname', 'OCRBackgroundCore',
  'OCRBackgroundMessageRouter',
  'OCRCaptureUtils', 'OCRContentStyles', 'OCRExtensionRuntime', 'OCRHistoryStore', 'OCRI18n',
  'OCROptionsRuntime', 'OCRPopupRuntime', 'OCRProviderAdapters', 'OCRProviderConfig', 'OCRRequestRuntime',
  'OCROptionsController', 'OCRProviderForm', 'OCRConfigTransfer', 'OCRPopupController', 'OCRHistoryView',
  'OCRCaptureSession', 'OCRSelection', 'OCRNoticeView', 'OCRResultView', 'OCRCapturePipeline',
  'OCRCaptureService', 'OCRRecognitionService', 'OCRBackgroundHandlers',
  'OCRProviderTransport', 'OCRClaudeProvider', 'OCROpenAIProvider', 'OCROpenAICompatibleProvider', 'OCRCustomProvider', 'OCRBaiduProvider', 'OCRAliyunProvider', 'OCRZhipuProvider',
].map((name) => [name, 'readonly']));

export default [
  {
    ignores: [
      '.codegraph/**',
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**'
    ]
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: sharedGlobals
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-constant-binary-expression': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'valid-typeof': 'error'
    }
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' }
  }
];
