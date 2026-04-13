// e2e/tests/navigation.spec.ts
// Verifies overlay state behavior across navigation events.

import { test, expect, MOCK_PORT } from '../fixtures';

test.describe('Navigation', () => {
    test('hard navigation preserves extension injection', async ({ context }) => {
        const page = await context.newPage();
        await page.goto(`https://claude.ai:${MOCK_PORT}/chat/nav-test-1`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(2000);

        // Verify extension injected
        const host1 = await page.$('#lco-widget-host');
        expect(host1).not.toBeNull();

        // Hard navigate to a different conversation
        await page.goto(`https://claude.ai:${MOCK_PORT}/chat/nav-test-2`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(2000);

        // Extension should re-inject on the new page
        const host2 = await page.$('#lco-widget-host');
        expect(host2).not.toBeNull();

        await page.close();
    });

    test('stream works after navigation to a new conversation', async ({ context }) => {
        const page = await context.newPage();
        const messages: string[] = [];
        page.on('console', (msg) => {
            if (msg.text().includes('[LCO]')) messages.push(msg.text());
        });

        await page.goto(`https://claude.ai:${MOCK_PORT}/chat/first-conv`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(2000);

        // Trigger stream on first conversation
        await page.click('#trigger-stream');
        await page.waitForTimeout(4000);

        const firstComplete = messages.filter(m => m.includes('[Complete]'));
        expect(firstComplete.length).toBe(1);

        // Navigate to new conversation
        messages.length = 0;
        await page.goto(`https://claude.ai:${MOCK_PORT}/chat/second-conv`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(2000);

        // Trigger stream on second conversation
        await page.click('#trigger-stream');
        await page.waitForTimeout(4000);

        const secondComplete = messages.filter(m => m.includes('[Complete]'));
        expect(secondComplete.length).toBe(1);

        await page.close();
    });

    test('navigating away from claude.ai cleans up', async ({ context }) => {
        const page = await context.newPage();
        await page.goto(`https://claude.ai:${MOCK_PORT}/chat/cleanup-test`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(2000);

        const hostBefore = await page.$('#lco-widget-host');
        expect(hostBefore).not.toBeNull();

        // Navigate to a non-claude.ai page (about:blank)
        await page.goto('about:blank');
        await page.waitForTimeout(1000);

        // Widget host should not exist on about:blank
        const hostAfter = await page.$('#lco-widget-host');
        expect(hostAfter).toBeNull();

        await page.close();
    });
});
