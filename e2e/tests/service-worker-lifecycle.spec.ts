// e2e/tests/service-worker-lifecycle.spec.ts
// Verifies service worker persistence and stream reliability across multiple requests.

import { test, expect } from '../fixtures';

test.describe('Service Worker Lifecycle', () => {
    test('second stream completes after first: worker stays alive between requests', async ({ context, mockPage }) => {
        // Playwright has no API to force-stop an extension service worker.
        // What this test validates: the worker is still active and functional
        // after handling a complete stream, and a second stream succeeds without
        // needing a worker restart. This catches regressions where the worker
        // crashes or enters a bad state after the first message channel closes.
        const firstRun: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[Complete]')) firstRun.push(msg.text());
        });

        await mockPage.click('#trigger-stream');
        await expect.poll(() => firstRun.length, { timeout: 8000 }).toBeGreaterThan(0);

        // Confirm worker is still registered after the first stream.
        const sw = context.serviceWorkers();
        expect(sw.length).toBeGreaterThan(0);
        expect(sw[0].url()).toContain('background.js');

        const secondRun: string[] = [];
        mockPage.removeAllListeners('console');
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[Complete]')) secondRun.push(msg.text());
        });

        await mockPage.click('#trigger-stream');
        await expect.poll(() => secondRun.length, { timeout: 8000 }).toBeGreaterThan(0);
    });

    test('multiple sequential streams work without worker issues', async ({ mockPage }) => {
        const completions: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[Complete]')) completions.push(msg.text());
        });

        for (let i = 0; i < 3; i++) {
            const countBefore = completions.length;
            await mockPage.click('#trigger-stream');
            await expect.poll(() => completions.length, { timeout: 8000 }).toBeGreaterThan(countBefore);
        }

        expect(completions.length).toBe(3);
    });
});
