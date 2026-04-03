// tests/unit/conversation-store.test.ts
// Comprehensive tests for the persistent conversation storage layer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    extractConversationId,
    todayDateString,
    isoWeekId,
    setStorage,
    recordTurn,
    finalizeConversation,
    getConversation,
    listConversations,
    pruneConversations,
    computeDailySummary,
    computeWeeklySummary,
    getDailySummary,
    listDailySummaries,
    getWeeklySummary,
    MAX_TURNS_PER_RECORD,
    CRITICAL_CONTEXT_PCT,
    type StorageArea,
    type TurnRecord,
    type ConversationRecord,
} from '../../lib/conversation-store';

// ── Storage mock ──────────────────────────────────────────────────────────────

function createStoreMock(): StorageArea & { _raw: Record<string, unknown> } {
    const data: Record<string, unknown> = {};
    return {
        get: vi.fn(async (keys: string | string[] | null) => {
            if (keys === null) return { ...data };
            const keyList = typeof keys === 'string' ? [keys] : keys;
            const result: Record<string, unknown> = {};
            for (const k of keyList) {
                if (k in data) result[k] = data[k];
            }
            return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(data, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
            const keyList = typeof keys === 'string' ? [keys] : keys;
            for (const k of keyList) delete data[k];
        }),
        _raw: data,
    };
}

function makeTurn(overrides: Partial<Omit<TurnRecord, 'turnNumber'>> = {}): Omit<TurnRecord, 'turnNumber'> {
    return {
        inputTokens: 1000,
        outputTokens: 200,
        model: 'claude-sonnet-4-6',
        contextPct: 5,
        cost: 0.006,
        completedAt: Date.now(),
        ...overrides,
    };
}

let mockStore: ReturnType<typeof createStoreMock>;

beforeEach(() => {
    mockStore = createStoreMock();
    setStorage(mockStore);
});

// ── Pure functions ────────────────────────────────────────────────────────────

describe('extractConversationId', () => {
    it('extracts UUID from /chat/{uuid} URL', () => {
        const url = 'https://claude.ai/chat/a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        expect(extractConversationId(url)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('extracts UUID from /chat_conversations/{uuid}/completion URL', () => {
        const url = 'https://claude.ai/api/organizations/org-123/chat_conversations/A1B2C3D4-E5F6-7890-ABCD-EF1234567890/completion';
        expect(extractConversationId(url)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('lowercases the UUID', () => {
        const url = 'https://claude.ai/chat/AABBCCDD-1122-3344-5566-778899AABBCC';
        expect(extractConversationId(url)).toBe('aabbccdd-1122-3344-5566-778899aabbcc');
    });

    it('returns null for homepage URL', () => {
        expect(extractConversationId('https://claude.ai/')).toBeNull();
    });

    it('returns null for settings URL', () => {
        expect(extractConversationId('https://claude.ai/settings')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(extractConversationId('')).toBeNull();
    });

    it('returns null for URL with partial UUID', () => {
        expect(extractConversationId('https://claude.ai/chat/a1b2c3')).toBeNull();
    });

    it('handles query strings after the UUID', () => {
        const url = 'https://claude.ai/chat/a1b2c3d4-e5f6-7890-abcd-ef1234567890?foo=bar';
        expect(extractConversationId(url)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });
});

describe('todayDateString', () => {
    it('returns YYYY-MM-DD format', () => {
        const result = todayDateString(new Date(2026, 3, 2).getTime()); // April 2, 2026
        expect(result).toBe('2026-04-02');
    });

    it('pads single-digit month and day', () => {
        const result = todayDateString(new Date(2026, 0, 5).getTime()); // Jan 5
        expect(result).toBe('2026-01-05');
    });
});

describe('isoWeekId', () => {
    it('returns correct ISO week for a known date', () => {
        // April 2, 2026 is a Thursday in week 14
        const result = isoWeekId(new Date(2026, 3, 2).getTime());
        expect(result).toBe('2026-W14');
    });

    it('handles year boundary (Jan 1 can be in previous year week)', () => {
        // Jan 1, 2026 is a Thursday in week 01
        const result = isoWeekId(new Date(2026, 0, 1).getTime());
        expect(result).toBe('2026-W01');
    });

    it('returns week 02 for Jan 5 2026 (first Monday of W02)', () => {
        // Jan 5, 2026 is a Monday. W01 ends Sunday Jan 4. Jan 5 starts W02.
        const result = isoWeekId(new Date(2026, 0, 5).getTime());
        expect(result).toBe('2026-W02');
    });
});

// ── recordTurn ────────────────────────────────────────────────────────────────

describe('recordTurn', () => {
    const CONV_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    it('creates a new ConversationRecord on first turn', async () => {
        const record = await recordTurn(CONV_ID, makeTurn());
        expect(record.id).toBe(CONV_ID);
        expect(record.turnCount).toBe(1);
        expect(record.turns).toHaveLength(1);
        expect(record.turns[0].turnNumber).toBe(1);
        expect(record.finalized).toBe(false);
        expect(record._v).toBe(1);
    });

    it('appends subsequent turns and updates aggregates', async () => {
        await recordTurn(CONV_ID, makeTurn({ inputTokens: 1000, outputTokens: 200, cost: 0.006 }));
        const record = await recordTurn(CONV_ID, makeTurn({ inputTokens: 2000, outputTokens: 400, cost: 0.012, contextPct: 10 }));

        expect(record.turnCount).toBe(2);
        expect(record.totalInputTokens).toBe(3000);
        expect(record.totalOutputTokens).toBe(600);
        expect(record.estimatedCost).toBeCloseTo(0.018);
        expect(record.peakContextPct).toBe(10);
        expect(record.lastContextPct).toBe(10);
        expect(record.turns).toHaveLength(2);
        expect(record.turns[1].turnNumber).toBe(2);
    });

    it('tracks peakContextPct across turns', async () => {
        await recordTurn(CONV_ID, makeTurn({ contextPct: 30 }));
        await recordTurn(CONV_ID, makeTurn({ contextPct: 70 }));
        const record = await recordTurn(CONV_ID, makeTurn({ contextPct: 50 }));

        expect(record.peakContextPct).toBe(70); // peak was turn 2
        expect(record.lastContextPct).toBe(50); // current is turn 3
    });

    it('caps the turns array at MAX_TURNS_PER_RECORD', async () => {
        for (let i = 0; i < MAX_TURNS_PER_RECORD + 5; i++) {
            await recordTurn(CONV_ID, makeTurn({ completedAt: Date.now() + i }));
        }
        const record = await getConversation(CONV_ID);
        expect(record!.turns).toHaveLength(MAX_TURNS_PER_RECORD);
        expect(record!.turnCount).toBe(MAX_TURNS_PER_RECORD + 5); // aggregate is still accurate
    });

    it('preserves aggregate accuracy after turns are capped', async () => {
        for (let i = 0; i < MAX_TURNS_PER_RECORD + 10; i++) {
            await recordTurn(CONV_ID, makeTurn({ inputTokens: 100, outputTokens: 10, cost: 0.001 }));
        }
        const record = await getConversation(CONV_ID);
        const totalTurns = MAX_TURNS_PER_RECORD + 10;
        expect(record!.totalInputTokens).toBe(100 * totalTurns);
        expect(record!.totalOutputTokens).toBe(10 * totalTurns);
        expect(record!.estimatedCost).toBeCloseTo(0.001 * totalTurns);
    });

    it('handles null cost gracefully', async () => {
        const record = await recordTurn(CONV_ID, makeTurn({ cost: null }));
        expect(record.estimatedCost).toBeNull();
    });

    it('transitions from null to non-null cost correctly', async () => {
        await recordTurn(CONV_ID, makeTurn({ cost: null }));
        const record = await recordTurn(CONV_ID, makeTurn({ cost: 0.005 }));
        expect(record.estimatedCost).toBeCloseTo(0.005);
    });

    it('adds to convIndex on first turn only', async () => {
        await recordTurn(CONV_ID, makeTurn());
        await recordTurn(CONV_ID, makeTurn());

        const index = mockStore._raw['convIndex'] as string[];
        expect(index.filter((id: string) => id === CONV_ID)).toHaveLength(1);
    });

    it('does not interfere between different conversations', async () => {
        const ID_A = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
        const ID_B = 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee';

        await recordTurn(ID_A, makeTurn({ inputTokens: 100 }));
        await recordTurn(ID_B, makeTurn({ inputTokens: 200 }));

        const a = await getConversation(ID_A);
        const b = await getConversation(ID_B);
        expect(a!.totalInputTokens).toBe(100);
        expect(b!.totalInputTokens).toBe(200);
    });

    it('updates the model to the latest turn model', async () => {
        await recordTurn(CONV_ID, makeTurn({ model: 'claude-haiku-4-5' }));
        const record = await recordTurn(CONV_ID, makeTurn({ model: 'claude-opus-4-6' }));
        expect(record.model).toBe('claude-opus-4-6');
    });
});

// ── finalizeConversation ──────────────────────────────────────────────────────

describe('finalizeConversation', () => {
    const CONV_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    it('sets finalized to true', async () => {
        await recordTurn(CONV_ID, makeTurn());
        await finalizeConversation(CONV_ID);
        const record = await getConversation(CONV_ID);
        expect(record!.finalized).toBe(true);
    });

    it('is a no-op for already finalized conversations', async () => {
        await recordTurn(CONV_ID, makeTurn());
        await finalizeConversation(CONV_ID);
        await finalizeConversation(CONV_ID); // second call
        const record = await getConversation(CONV_ID);
        expect(record!.finalized).toBe(true);
    });

    it('is a no-op for non-existent conversations', async () => {
        await expect(finalizeConversation('nonexistent-id')).resolves.not.toThrow();
    });
});

// ── listConversations ─────────────────────────────────────────────────────────

describe('listConversations', () => {
    it('returns conversations in newest-first order', async () => {
        await recordTurn('conv-a', makeTurn({ completedAt: 1000 }));
        await recordTurn('conv-b', makeTurn({ completedAt: 2000 }));
        await recordTurn('conv-c', makeTurn({ completedAt: 3000 }));

        const list = await listConversations(10);
        // Index order is newest first (unshift), so conv-c was added last
        expect(list[0].id).toBe('conv-c');
        expect(list[2].id).toBe('conv-a');
    });

    it('respects the limit parameter', async () => {
        for (let i = 0; i < 5; i++) {
            await recordTurn(`conv-${i}`, makeTurn());
        }
        const list = await listConversations(3);
        expect(list).toHaveLength(3);
    });

    it('supports offset for pagination', async () => {
        for (let i = 0; i < 5; i++) {
            await recordTurn(`conv-${i}`, makeTurn());
        }
        const page1 = await listConversations(2, 0);
        const page2 = await listConversations(2, 2);
        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(2);
        expect(page1[0].id).not.toBe(page2[0].id);
    });

    it('returns empty array when no conversations exist', async () => {
        const list = await listConversations(10);
        expect(list).toEqual([]);
    });
});

// ── pruneConversations ────────────────────────────────────────────────────────

describe('pruneConversations', () => {
    it('removes conversations older than the cutoff', async () => {
        const old = Date.now() - 100 * 86400000; // 100 days ago
        const recent = Date.now() - 10 * 86400000; // 10 days ago

        await recordTurn('old-conv', makeTurn({ completedAt: old }));
        await recordTurn('new-conv', makeTurn({ completedAt: recent }));

        const cutoff = Date.now() - 90 * 86400000;
        const deleted = await pruneConversations(cutoff);

        expect(deleted).toBe(1);
        expect(await getConversation('old-conv')).toBeNull();
        expect(await getConversation('new-conv')).not.toBeNull();
    });

    it('cleans up the index after pruning', async () => {
        const old = Date.now() - 100 * 86400000;
        await recordTurn('old-conv', makeTurn({ completedAt: old }));

        const cutoff = Date.now() - 90 * 86400000;
        await pruneConversations(cutoff);

        const index = mockStore._raw['convIndex'] as string[];
        expect(index).not.toContain('old-conv');
    });

    it('returns 0 when nothing to prune', async () => {
        await recordTurn('fresh-conv', makeTurn({ completedAt: Date.now() }));
        const deleted = await pruneConversations(Date.now() - 90 * 86400000);
        expect(deleted).toBe(0);
    });
});

// ── computeDailySummary ───────────────────────────────────────────────────────

describe('computeDailySummary', () => {
    it('aggregates turns that fall on the target date', async () => {
        // Create a conversation with turns on April 2
        const april2Start = new Date('2026-04-02T10:00:00').getTime();
        await recordTurn('conv-a', makeTurn({ inputTokens: 500, outputTokens: 100, cost: 0.003, completedAt: april2Start }));
        await recordTurn('conv-a', makeTurn({ inputTokens: 600, outputTokens: 120, cost: 0.004, completedAt: april2Start + 3600000 }));

        const summary = await computeDailySummary('2026-04-02');
        expect(summary.conversationCount).toBe(1);
        expect(summary.totalTurns).toBe(2);
        expect(summary.totalInputTokens).toBe(1100);
        expect(summary.totalOutputTokens).toBe(220);
        expect(summary.estimatedCost).toBeCloseTo(0.007);
    });

    it('counts critical conversations correctly', async () => {
        await recordTurn('conv-a', makeTurn({ contextPct: 85, completedAt: new Date('2026-04-02T12:00:00').getTime() }));
        await recordTurn('conv-b', makeTurn({ contextPct: 30, completedAt: new Date('2026-04-02T13:00:00').getTime() }));

        const summary = await computeDailySummary('2026-04-02');
        expect(summary.criticalConversations).toBe(1); // conv-a peaked at 85 >= 80
    });

    it('builds model breakdown', async () => {
        const ts = new Date('2026-04-02T10:00:00').getTime();
        await recordTurn('conv-a', makeTurn({ model: 'claude-opus-4-6', completedAt: ts }));
        await recordTurn('conv-b', makeTurn({ model: 'claude-haiku-4-5', completedAt: ts + 1000 }));

        const summary = await computeDailySummary('2026-04-02');
        expect(summary.modelBreakdown).toHaveLength(2);
        const opus = summary.modelBreakdown.find(m => m.model === 'claude-opus-4-6');
        expect(opus).toBeDefined();
        expect(opus!.conversationCount).toBe(1);
    });

    it('returns zero-value summary for a day with no activity', async () => {
        const summary = await computeDailySummary('2026-04-02');
        expect(summary.conversationCount).toBe(0);
        expect(summary.totalTurns).toBe(0);
        expect(summary.estimatedCost).toBeNull();
    });

    it('stores the summary and updates the index', async () => {
        const ts = new Date('2026-04-02T10:00:00').getTime();
        await recordTurn('conv-a', makeTurn({ completedAt: ts }));

        await computeDailySummary('2026-04-02');

        const stored = await getDailySummary('2026-04-02');
        expect(stored).not.toBeNull();
        expect(stored!.date).toBe('2026-04-02');
    });
});

// ── computeWeeklySummary ──────────────────────────────────────────────────────

describe('computeWeeklySummary', () => {
    it('aggregates from daily summaries', async () => {
        // Seed two daily summaries (Mon and Tue of week 14, 2026)
        // Week 14 starts March 30 (Mon) through April 5 (Sun)
        const mon = new Date('2026-03-30T10:00:00').getTime();
        const tue = new Date('2026-03-31T10:00:00').getTime();

        await recordTurn('conv-mon', makeTurn({ inputTokens: 1000, outputTokens: 200, cost: 0.006, completedAt: mon }));
        await recordTurn('conv-tue', makeTurn({ inputTokens: 2000, outputTokens: 400, cost: 0.012, completedAt: tue }));

        await computeDailySummary('2026-03-30');
        await computeDailySummary('2026-03-31');

        const weekly = await computeWeeklySummary('2026-W14');
        expect(weekly.conversationCount).toBe(2);
        expect(weekly.totalTokens).toBe(3600); // 1000+200 + 2000+400
        expect(weekly.weekId).toBe('2026-W14');
    });

    it('identifies the heaviest day', async () => {
        const mon = new Date('2026-03-30T10:00:00').getTime();
        const wed = new Date('2026-04-01T10:00:00').getTime();

        await recordTurn('conv-mon', makeTurn({ inputTokens: 100, outputTokens: 10, completedAt: mon }));
        await recordTurn('conv-wed', makeTurn({ inputTokens: 5000, outputTokens: 1000, completedAt: wed }));

        await computeDailySummary('2026-03-30');
        await computeDailySummary('2026-04-01');

        const weekly = await computeWeeklySummary('2026-W14');
        expect(weekly.heaviestDay).toBe(2); // Wednesday (0=Mon)
    });

    it('stores and retrieves correctly', async () => {
        await computeWeeklySummary('2026-W14');
        const stored = await getWeeklySummary('2026-W14');
        expect(stored).not.toBeNull();
        expect(stored!.weekId).toBe('2026-W14');
    });
});

// ── listDailySummaries ────────────────────────────────────────────────────────

describe('listDailySummaries', () => {
    it('returns summaries for the requested number of days', async () => {
        // Seed a summary for today
        const ts = Date.now();
        await recordTurn('conv-a', makeTurn({ completedAt: ts }));
        const today = todayDateString(ts);
        await computeDailySummary(today);

        const summaries = await listDailySummaries(7);
        expect(summaries.length).toBeGreaterThanOrEqual(1);
        expect(summaries[0].date).toBe(today);
    });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
    it('getConversation returns null for non-existent ID', async () => {
        expect(await getConversation('nonexistent')).toBeNull();
    });

    it('getDailySummary returns null for non-existent date', async () => {
        expect(await getDailySummary('2026-01-01')).toBeNull();
    });

    it('getWeeklySummary returns null for non-existent week', async () => {
        expect(await getWeeklySummary('2026-W01')).toBeNull();
    });

    it('recordTurn after finalize still works (conversation reopened)', async () => {
        const CONV_ID = 'reopen-test';
        await recordTurn(CONV_ID, makeTurn());
        await finalizeConversation(CONV_ID);
        const record = await recordTurn(CONV_ID, makeTurn());
        expect(record.turnCount).toBe(2);
        // finalized stays true from before; the new turn just appends
    });
});
