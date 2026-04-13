// e2e/tests/multi-tab.spec.ts
// Verifies per-tab isolation: each tab has its own overlay state.

import { test, expect, MOCK_PORT } from '../fixtures';

test.describe('Multi-Tab Isolation', () => {
    test('two tabs show independent overlay data', async ({ context }) => {
        const page1 = await context.newPage();
        const page2 = await context.newPage();

        await page1.goto(`https://claude.ai:${MOCK_PORT}/chat/conv-111`, { waitUntil: 'domcontentloaded' });
        await page2.goto(`https://claude.ai:${MOCK_PORT}/chat/conv-222`, { waitUntil: 'domcontentloaded' });

        // Wait for each content script to fully initialize before clicking.
        await page1.waitForSelector('#lco-widget-host', { state: 'attached', timeout: 10000 });
        await page2.waitForSelector('#lco-widget-host', { state: 'attached', timeout: 10000 });

        const tab1Messages: string[] = [];
        const tab2Messages: string[] = [];
        page1.on('console', (msg) => {
            if (msg.text().includes('[Complete]')) tab1Messages.push(msg.text());
        });
        page2.on('console', (msg) => {
            if (msg.text().includes('[Complete]')) tab2Messages.push(msg.text());
        });

        await page1.click('#trigger-stream');
        await page2.click('#trigger-stream-long');

        await expect.poll(() => tab1Messages.length, { timeout: 8000 }).toBeGreaterThan(0);
        expect(tab1Messages[0]).toContain('claude-sonnet-4-6');

        // 1000 deltas at 5ms each = ~5s + overhead
        await expect.poll(() => tab2Messages.length, { timeout: 15000 }).toBeGreaterThan(0);

        const host1 = await page1.$('#lco-widget-host');
        const host2 = await page2.$('#lco-widget-host');
        expect(host1).not.toBeNull();
        expect(host2).not.toBeNull();

        await page1.close();
        await page2.close();
    });

    test('closing one tab does not affect the other', async ({ context }) => {
        const page1 = await context.newPage();
        const page2 = await context.newPage();

        await page1.goto(`https://claude.ai:${MOCK_PORT}/chat/conv-aaa`, { waitUntil: 'domcontentloaded' });
        await page2.goto(`https://claude.ai:${MOCK_PORT}/chat/conv-bbb`, { waitUntil: 'domcontentloaded' });

        await page1.waitForSelector('#lco-widget-host', { state: 'attached', timeout: 10000 });
        await page2.waitForSelector('#lco-widget-host', { state: 'attached', timeout: 10000 });

        const p1Done: string[] = [];
        const p2Done: string[] = [];
        page1.on('console', (msg) => { if (msg.text().includes('[Complete]')) p1Done.push(msg.text()); });
        page2.on('console', (msg) => { if (msg.text().includes('[Complete]')) p2Done.push(msg.text()); });

        await page1.click('#trigger-stream');
        await page2.click('#trigger-stream');

        await expect.poll(() => p1Done.length, { timeout: 8000 }).toBeGreaterThan(0);
        await expect.poll(() => p2Done.length, { timeout: 8000 }).toBeGreaterThan(0);

        await page1.close();

        const host2 = await page2.$('#lco-widget-host');
        expect(host2).not.toBeNull();

        const errors: string[] = [];
        page2.on('console', (msg) => {
            if (msg.type() === 'error' && msg.text().includes('Uncaught')) errors.push(msg.text());
        });

        const thirdDone: string[] = [];
        page2.on('console', (msg) => { if (msg.text().includes('[Complete]')) thirdDone.push(msg.text()); });
        await page2.click('#trigger-stream');
        await expect.poll(() => thirdDone.length, { timeout: 8000 }).toBeGreaterThan(0);

        expect(errors.length).toBe(0);

        await page2.close();
    });
});
