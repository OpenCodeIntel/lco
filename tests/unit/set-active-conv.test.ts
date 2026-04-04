// tests/unit/set-active-conv.test.ts
// Tests for the SET_ACTIVE_CONV handler in background.ts (lines 286-297).
// Mirrors the handler logic for active conversation tracking in session storage.

import { describe, it, expect, vi } from 'vitest';

// -- Mirrored handler logic from background.ts --

interface SessionStorage {
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (keys: string[]) => Promise<void>;
}

interface SetActiveConvMessage {
    type: 'SET_ACTIVE_CONV';
    conversationId: string | null;
}

/**
 * Mirrors the SET_ACTIVE_CONV handler from background.ts.
 * Writes or clears the activeConv_{tabId} key in session storage.
 */
function handleSetActiveConv(
    message: SetActiveConvMessage,
    tabId: number | undefined,
    storage: SessionStorage,
): { ok: boolean } {
    if (tabId !== undefined) {
        const key = `activeConv_${tabId}`;
        if (message.conversationId) {
            storage.set({ [key]: message.conversationId }).catch(() => { /* non-critical */ });
        } else {
            storage.remove([key]).catch(() => { /* non-critical */ });
        }
    }
    return { ok: true };
}

// -- Tests --

describe('SET_ACTIVE_CONV handler', () => {
    function makeStorage(): SessionStorage & { _ops: Array<{ op: string; args: unknown }> } {
        const ops: Array<{ op: string; args: unknown }> = [];
        return {
            set: vi.fn(async (items) => { ops.push({ op: 'set', args: items }); }),
            remove: vi.fn(async (keys) => { ops.push({ op: 'remove', args: keys }); }),
            _ops: ops,
        };
    }

    it('writes conversationId to activeConv_{tabId} in session storage', () => {
        const storage = makeStorage();
        handleSetActiveConv(
            { type: 'SET_ACTIVE_CONV', conversationId: 'conv-abc-123' },
            42,
            storage,
        );

        expect(storage.set).toHaveBeenCalledWith({ activeConv_42: 'conv-abc-123' });
    });

    it('removes activeConv_{tabId} when conversationId is null', () => {
        const storage = makeStorage();
        handleSetActiveConv(
            { type: 'SET_ACTIVE_CONV', conversationId: null },
            42,
            storage,
        );

        expect(storage.remove).toHaveBeenCalledWith(['activeConv_42']);
    });

    it('does nothing when tabId is undefined', () => {
        const storage = makeStorage();
        handleSetActiveConv(
            { type: 'SET_ACTIVE_CONV', conversationId: 'conv-abc-123' },
            undefined,
            storage,
        );

        expect(storage.set).not.toHaveBeenCalled();
        expect(storage.remove).not.toHaveBeenCalled();
    });

    it('always returns ok: true', () => {
        const storage = makeStorage();

        const r1 = handleSetActiveConv(
            { type: 'SET_ACTIVE_CONV', conversationId: 'conv-1' },
            1,
            storage,
        );
        expect(r1).toEqual({ ok: true });

        const r2 = handleSetActiveConv(
            { type: 'SET_ACTIVE_CONV', conversationId: null },
            1,
            storage,
        );
        expect(r2).toEqual({ ok: true });

        const r3 = handleSetActiveConv(
            { type: 'SET_ACTIVE_CONV', conversationId: 'conv-2' },
            undefined,
            storage,
        );
        expect(r3).toEqual({ ok: true });
    });

    it('uses the correct key format for different tab IDs', () => {
        const storage = makeStorage();

        handleSetActiveConv({ type: 'SET_ACTIVE_CONV', conversationId: 'a' }, 1, storage);
        handleSetActiveConv({ type: 'SET_ACTIVE_CONV', conversationId: 'b' }, 999, storage);

        expect(storage.set).toHaveBeenNthCalledWith(1, { activeConv_1: 'a' });
        expect(storage.set).toHaveBeenNthCalledWith(2, { activeConv_999: 'b' });
    });

    it('treats empty string conversationId as falsy (clears key)', () => {
        const storage = makeStorage();
        // Empty string is falsy in JS, so the handler should remove the key
        handleSetActiveConv(
            { type: 'SET_ACTIVE_CONV', conversationId: '' as unknown as null },
            42,
            storage,
        );

        expect(storage.remove).toHaveBeenCalledWith(['activeConv_42']);
    });

    it('handles storage.set rejection gracefully', async () => {
        const storage = makeStorage();
        (storage.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('quota exceeded'));

        // Should not throw
        const result = handleSetActiveConv(
            { type: 'SET_ACTIVE_CONV', conversationId: 'conv-1' },
            1,
            storage,
        );
        expect(result).toEqual({ ok: true });
    });

    it('handles storage.remove rejection gracefully', async () => {
        const storage = makeStorage();
        (storage.remove as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('quota exceeded'));

        const result = handleSetActiveConv(
            { type: 'SET_ACTIVE_CONV', conversationId: null },
            1,
            storage,
        );
        expect(result).toEqual({ ok: true });
    });
});
