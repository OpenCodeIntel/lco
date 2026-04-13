// e2e/fixtures.ts
// Playwright fixtures for launching Chromium with the LCO extension loaded.
// Uses host-resolver-rules to redirect claude.ai to the local mock server.

import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
export const MOCK_PORT = 3456;

export const test = base.extend<{
    context: BrowserContext;
    extensionId: string;
    mockPage: Page;
}>({
    // eslint-disable-next-line no-empty-pattern
    context: async ({}, use) => {
        const context = await chromium.launchPersistentContext('', {
            headless: false,
            args: [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                // Redirect claude.ai DNS to localhost so the content script activates
                `--host-resolver-rules=MAP claude.ai 127.0.0.1:${MOCK_PORT}`,
                // Accept our self-signed cert
                '--ignore-certificate-errors',
                // Disable first-run UI
                '--no-first-run',
                '--no-default-browser-check',
            ],
        });

        // Pre-enable LCO so the content script does not show the enable banner
        // and instead initializes monitoring immediately.
        // We need the extension ID first. Get it from the service worker.
        const serviceWorkers = context.serviceWorkers();
        let extensionId = '';
        if (serviceWorkers.length > 0) {
            extensionId = serviceWorkers[0].url().split('/')[2];
        } else {
            // Wait for the service worker to register
            const sw = await context.waitForEvent('serviceworker');
            extensionId = sw.url().split('/')[2];
        }

        // Set lco_enabled_claude = true via the extension's storage API.
        // We do this by navigating to the extension's background page and running JS.
        const bgPage = await context.newPage();
        await bgPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
        await bgPage.evaluate(() => {
            return new Promise<void>((resolve) => {
                chrome.storage.local.set({ lco_enabled_claude: true }, () => resolve());
            });
        });
        await bgPage.close();

        await use(context);
        await context.close();
    },

    extensionId: async ({ context }, use) => {
        // serviceWorkers() is synchronous. If the context fixture ran first (it always
        // does, since extensionId depends on context), the worker is already registered.
        // The fallback waitForEvent handles the rare case where the list is still empty.
        const sw = context.serviceWorkers();
        const id = sw.length > 0
            ? sw[0].url().split('/')[2]
            : (await context.waitForEvent('serviceworker')).url().split('/')[2];
        await use(id);
    },

    mockPage: async ({ context }, use) => {
        const page = await context.newPage();
        // Navigate to claude.ai which resolves to our mock server via host-resolver-rules.
        // Use port 3456 because that is where our HTTPS mock listens.
        await page.goto(`https://claude.ai:${MOCK_PORT}/chat/test-conversation`, {
            waitUntil: 'domcontentloaded',
        });
        // Wait for the content script to finish its async init and attach the shadow host.
        // state: 'attached' checks DOM presence only — the host has zero dimensions until
        // the first stream fires, so the default visibility check would timeout here.
        await page.waitForSelector('#lco-widget-host', { state: 'attached', timeout: 10000 });
        await use(page);
    },
});

export { expect } from '@playwright/test';
