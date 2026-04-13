import { defineConfig } from '@playwright/test';

export default defineConfig({
    globalSetup: './global-setup.ts',
    testDir: './tests',
    timeout: 60000,
    retries: 0,
    workers: 1, // extensions share browser state; parallel is unsafe
    use: {
        headless: false, // extensions require headed mode
    },
    webServer: {
        command: 'bun run e2e/mock-server.ts',
        port: 3456,
        reuseExistingServer: !process.env.CI,
        timeout: 10000,
    },
});
