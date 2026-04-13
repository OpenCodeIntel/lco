// e2e/tests/extension-loads.spec.ts
// Verifies the extension installs, service worker registers, and content script injects.

import { test, expect } from '../fixtures';

test.describe('Extension Loading', () => {
    test('service worker is registered and active', async ({ context }) => {
        const serviceWorkers = context.serviceWorkers();
        expect(serviceWorkers.length).toBeGreaterThan(0);

        const swUrl = serviceWorkers[0].url();
        expect(swUrl).toContain('background.js');
    });

    test('extension ID is a valid Chrome extension ID', async ({ extensionId }) => {
        // Chrome extension IDs are 32 lowercase letters
        expect(extensionId).toMatch(/^[a-z]{32}$/);
    });

    test('content script injects on claude.ai page', async ({ mockPage }) => {
        // mockPage fixture already awaited waitForSelector('#lco-widget-host', { state: 'attached' }).
        // Reaching this line means the element is in the DOM; assert it directly.
        const host = await mockPage.$('#lco-widget-host');
        expect(host).not.toBeNull();
    });

    test('inject.ts runs and logs initialization', async ({ mockPage }) => {
        const messages: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[LCO]')) messages.push(msg.text());
        });

        // Subscribe before reload so no events are missed.
        const initPromise = mockPage.waitForEvent('console', (msg) =>
            msg.text().includes('Fetch interceptor initialized'),
        );
        await mockPage.reload({ waitUntil: 'domcontentloaded' });
        await initPromise;

        const initMsg = messages.find(m => m.includes('Fetch interceptor initialized'));
        expect(initMsg).toBeDefined();
    });
});
