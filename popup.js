/** Page entry: assemble one controller and start after DOM readiness. */
document.addEventListener('DOMContentLoaded', () => {
  const controller = OCRPopupController.create({
    document, window, chrome, navigator, i18n: OCRI18n, config: OCRProviderConfig,
    runtime: OCRExtensionRuntime, popupRuntime: OCRPopupRuntime, historyModule: OCRHistoryView
  });
  controller.init().catch(error => console.error('Page initialization failed:', error));
}, { once: true });
