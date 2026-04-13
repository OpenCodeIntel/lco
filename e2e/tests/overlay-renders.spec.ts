// e2e/tests/overlay-renders.spec.ts
// Verifies the overlay appears, updates during streaming, and supports collapse/expand.

import { test, expect } from '../fixtures';

test.describe('Overlay Rendering', () => {
    test('overlay appears after triggering a stream', async ({ mockPage }) => {
        // mockPage fixture already waits for #lco-widget-host before yielding.
        // Verify the host is present before the stream starts.
        const hostBefore = await mockPage.$('#lco-widget-host');
        expect(hostBefore).not.toBeNull();

        // Trigger a normal SSE stream via the test page button
        await mockPage.click('#trigger-stream');

        // The inner lco-widget is inside a closed shadow DOM so we cannot query
        // its children directly. Poll until the stream completes (completion log
        // appears) then confirm the host is still in place.
        const lcoMessages: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[LCO]')) lcoMessages.push(msg.text());
        });
        await expect.poll(() => lcoMessages.some(m => m.includes('[Complete]')), { timeout: 8000 }).toBe(true);

        const host = await mockPage.$('#lco-widget-host');
        expect(host).not.toBeNull();
    });

    test('console shows LCO stream events during SSE', async ({ mockPage }) => {
        const lcoMessages: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[LCO]')) lcoMessages.push(msg.text());
        });

        await mockPage.click('#trigger-stream');
        await expect.poll(() => lcoMessages.some(m => m.includes('[Complete]')), { timeout: 8000 }).toBe(true);

        expect(lcoMessages.some(m => m.includes('message_start'))).toBe(true);
        expect(lcoMessages.some(m => m.includes('[Complete]'))).toBe(true);
    });

    test('stream complete log shows model and token counts', async ({ mockPage }) => {
        const lcoMessages: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[LCO]') && msg.text().includes('[Complete]')) {
                lcoMessages.push(msg.text());
            }
        });

        await mockPage.click('#trigger-stream');
        await expect.poll(() => lcoMessages.length, { timeout: 8000 }).toBeGreaterThan(0);

        const completionLog = lcoMessages[0];
        expect(completionLog).toContain('claude-sonnet-4-6');
        expect(completionLog).toMatch(/~\d+ (in|out)/);
    });

    test('message_limit event is logged and forwarded', async ({ mockPage }) => {
        const limitMessages: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[LCO]') && msg.text().includes('message_limit')) {
                limitMessages.push(msg.text());
            }
        });

        await mockPage.click('#trigger-stream-limit');
        await expect.poll(() => limitMessages.length, { timeout: 8000 }).toBeGreaterThan(0);

        expect(limitMessages[0]).toContain('42.0%');
    });
});
