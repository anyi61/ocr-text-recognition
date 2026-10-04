'use strict';

// Keep the default test directory in configuration. Passing it as a positional
// CLI filter would make explicit file filters match the entire suite as well.
module.exports = { testDir: './tests/e2e', workers: 1, reporter: 'line' };
