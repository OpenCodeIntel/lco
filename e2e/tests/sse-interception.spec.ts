// e2e/tests/sse-interception.spec.ts
// Verifies the fetch interceptor handles all SSE stream scenarios correctly.

import { test, expect } from '../fixtures';

test.describe('SSE Interception', () => {
    test('normal stream: all events parsed, completion logged', async ({ mockPage }) => {
        const messages: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[LCO]')) messages.push(msg.text());
        });

        await mockPage.click('#trigger-stream');
        await expect.poll(() => messages.some(m => m.includes('[Complete]')), { timeout: 8000 }).toBe(true);

        expect(messages.some(m => m.includes('message_start'))).toBe(true);
        expect(messages.some(m => m.includes('stop_reason: end_turn'))).toBe(true);
        expect(messages.some(m => m.includes('stream confirmed complete'))).toBe(true);
        expect(messages.some(m => m.includes('[Complete]'))).toBe(true);
    });

    test('long stream (1000 deltas): no crash, counts accumulate', async ({ mockPage }) => {
        const completeMessages: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('[LCO]') && msg.text().includes('[Complete]')) {
                completeMessages.push(msg.text());
            }
        });

        await mockPage.click('#trigger-stream-long');
        // 1000 deltas at 5ms each = ~5s + BPE tokenization overhead
        await expect.poll(() => completeMessages.length, { timeout: 15000 }).toBeGreaterThan(0);

        const match = completeMessages[0].match(/~(\d+) out/);
        expect(match).not.toBeNull();
        if (match) {
            const outTokens = parseInt(match[1], 10);
            // 1000 deltas of ~6 chars each = ~6000 chars; BPE > 100
            expect(outTokens).toBeGreaterThan(100);
        }
    });

    test('error stream (500): extension does not crash', async ({ mockPage }) => {
        const errors: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text());
        });

        // Trigger error scenario: mock returns 500 with no body stream
        await mockPage.evaluate(() => { (window as any).triggerStream('error'); });
        await expect.poll(
            () => mockPage.$eval('#log', el => el.textContent ?? ''),
            { timeout: 6000 },
        ).toContain('500');

        const crashes = errors.filter(e => e.includes('Uncaught') || e.includes('unhandled'));
        expect(crashes.length).toBe(0);
    });

    test('rate limit (429): extension does not break', async ({ mockPage }) => {
        const errors: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.type() === 'error' && msg.text().includes('Uncaught')) errors.push(msg.text());
        });

        await mockPage.evaluate(() => { (window as any).triggerStream('ratelimit'); });
        await expect.poll(
            () => mockPage.$eval('#log', el => el.textContent ?? ''),
            { timeout: 6000 },
        ).toContain('429');

        expect(errors.length).toBe(0);
    });

    test('malformed stream: extension recovers gracefully', async ({ mockPage }) => {
        const debugMessages: string[] = [];
        const completeMessages: string[] = [];
        mockPage.on('console', (msg) => {
            if (msg.text().includes('Skipped malformed JSON')) debugMessages.push(msg.text());
            if (msg.text().includes('[Complete]')) completeMessages.push(msg.text());
        });

        await mockPage.click('#trigger-stream-malformed');
        await expect.poll(() => completeMessages.length, { timeout: 8000 }).toBeGreaterThan(0);

        expect(debugMessages.length).toBeGreaterThan(0);
    });
});
