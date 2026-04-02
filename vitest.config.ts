import { defineConfig } from 'vitest/config';

// Vitest configuration for the LCO extension.
// The test suite runs in a Node.js environment, mocking the Chrome Extension
// APIs (browser.*, chrome.*) that are only available inside the actual extension runtime.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Only measure lib/ — entrypoints depend on browser APIs and cannot be
      // unit tested without a real extension runtime. Enforcing thresholds on
      // untestable code would make the coverage gate meaningless.
      include: ['lib/**'],
      exclude: [
        'lib/adapters/types.ts', // interface-only file, no executable lines
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
