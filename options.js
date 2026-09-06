/** Page entry: assemble one controller and start after DOM readiness. */
document.addEventListener('DOMContentLoaded', () => {
  const controller = OCROptionsController.create({
    document, window, chrome, navigator, i18n: OCRI18n, config: OCRProviderConfig,
    runtime: OCRExtensionRuntime, optionsRuntime: OCROptionsRuntime, formModule: OCRProviderForm,
    transferModule: OCRConfigTransfer, getRuntimeVersion: () => chrome.runtime.getManifest().version
  });
  controller.init().catch(error => console.error('Page initialization failed:', error));
}, { once: true });
