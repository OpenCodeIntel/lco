// tests/unit/token-bridge.test.ts
// Tests for the BPE token counting bridge in inject.ts (lines 102-132).
// Mirrors the countTokens() function and its pending-request Map so it
// can run in Node without a browser runtime.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// -- Mirrored token bridge from inject.ts --

type ResolveCallback = (count: number) => void;

interface TokenBridge {
    countTokens: (text: string) => Promise<number>;
    /** Simulate a response from the content script BPE relay. */
    receiveResponse: (id: number, count: number) => void;
    /** Number of pending (unresolved) requests. */
    pendingCount: () => number;
}

/**
 * Factory that mirrors the token bridge from inject.ts.
 * Uses a postMessage spy instead of real window.postMessage.
 */
function createTokenBridge(postMessage: (msg: unknown) => void): TokenBridge {
    let idCounter = 0;
    const pending = new Map<number, ResolveCallback>();

    function receiveResponse(id: number, count: number): void {
        const resolve = pending.get(id);
        if (resolve) {
            pending.delete(id);
            resolve(count);
        }
    }

    async function countTokens(text: string): Promise<number> {
        if (!text) return 0;
        return new Promise((resolve) => {
            const id = ++idCounter;
            pending.set(id, resolve);
            postMessage({ type: 'LCO_TOKEN_REQ', id, text });

            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    resolve(0);
                }
            }, 5000);
        });
    }

    return { countTokens, receiveResponse, pendingCount: () => pending.size };
}

// -- Tests --

describe('token bridge', () => {
    let postMessageSpy: ReturnType<typeof vi.fn<(msg: unknown) => void>>;
    let bridge: TokenBridge;

    beforeEach(() => {
        vi.useFakeTimers();
        postMessageSpy = vi.fn<(msg: unknown) => void>();
        bridge = createTokenBridge(postMessageSpy);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns 0 for empty string without posting a message', async () => {
        const result = await bridge.countTokens('');
        expect(result).toBe(0);
        expect(postMessageSpy).not.toHaveBeenCalled();
    });

    it('posts LCO_TOKEN_REQ with incremented ID and text', () => {
        bridge.countTokens('hello world');
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: 'LCO_TOKEN_REQ',
            id: 1,
            text: 'hello world',
        });
    });

    it('resolves with count from a matching response', async () => {
        const promise = bridge.countTokens('hello world');
        bridge.receiveResponse(1, 42);
        const result = await promise;
        expect(result).toBe(42);
    });

    it('falls back to 0 after 5s timeout', async () => {
        const promise = bridge.countTokens('hello world');
        expect(bridge.pendingCount()).toBe(1);

        vi.advanceTimersByTime(5000);
        const result = await promise;
        expect(result).toBe(0);
        expect(bridge.pendingCount()).toBe(0);
    });

    it('cleans up pending request on successful response', async () => {
        const promise = bridge.countTokens('text');
        expect(bridge.pendingCount()).toBe(1);

        bridge.receiveResponse(1, 10);
        await promise;
        expect(bridge.pendingCount()).toBe(0);
    });

    it('cleans up pending request on timeout', async () => {
        bridge.countTokens('text');
        expect(bridge.pendingCount()).toBe(1);

        vi.advanceTimersByTime(5000);
        // Let the microtask queue flush
        await vi.advanceTimersByTimeAsync(0);
        expect(bridge.pendingCount()).toBe(0);
    });

    it('resolves multiple concurrent calls independently', async () => {
        const p1 = bridge.countTokens('first');
        const p2 = bridge.countTokens('second');
        const p3 = bridge.countTokens('third');
        expect(bridge.pendingCount()).toBe(3);

        bridge.receiveResponse(2, 20);
        bridge.receiveResponse(1, 10);
        bridge.receiveResponse(3, 30);

        expect(await p1).toBe(10);
        expect(await p2).toBe(20);
        expect(await p3).toBe(30);
        expect(bridge.pendingCount()).toBe(0);
    });

    it('ignores late response after timeout', async () => {
        const promise = bridge.countTokens('text');

        // Timeout fires first
        vi.advanceTimersByTime(5000);
        const result = await promise;
        expect(result).toBe(0);

        // Late response arrives: should be a no-op (no crash, no double-resolve)
        bridge.receiveResponse(1, 999);
        expect(bridge.pendingCount()).toBe(0);
    });

    it('does not resolve a request with the wrong ID', async () => {
        const promise = bridge.countTokens('text');

        // Send response with ID 999 (does not match ID 1)
        bridge.receiveResponse(999, 42);
        expect(bridge.pendingCount()).toBe(1);

        // The original request is still pending; timeout resolves it
        vi.advanceTimersByTime(5000);
        expect(await promise).toBe(0);
    });

    it('increments IDs across calls', () => {
        bridge.countTokens('a');
        bridge.countTokens('b');
        bridge.countTokens('c');

        expect(postMessageSpy).toHaveBeenCalledTimes(3);
        expect(postMessageSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 1 }));
        expect(postMessageSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 2 }));
        expect(postMessageSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({ id: 3 }));
    });

    it('does not start timeout for empty string', async () => {
        await bridge.countTokens('');
        vi.advanceTimersByTime(10000);
        // No pending requests, no timeouts, no crashes
        expect(bridge.pendingCount()).toBe(0);
    });
});
