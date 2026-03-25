import { defineConfig } from 'wxt';

// Reference: https://wxt.dev/api/config.html
export default defineConfig({
  webExt: {
    chromiumArgs: ['--user-data-dir=./.wxt/chrome-data'],
    // Persistent profile: Retains claude.ai cookies across dev restarts.
    // First run requires establishing Developer mode in chrome://extensions.
  },
  manifest: {
    name: 'Local Context Optimizer',
    description: 'Real-time token counting and cost tracking for AI platforms',
    permissions: ['storage', 'tabs', 'scripting', 'alarms'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
    },
    host_permissions: [],
    optional_host_permissions: ['https://claude.ai/*'],
    web_accessible_resources: [
      {
        resources: ['inject.js'],
        matches: ['https://claude.ai/*'],
      },
    ],
  },
});
