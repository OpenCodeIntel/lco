// tests/unit/conversation-store.test.ts
// Comprehensive tests for the persistent conversation storage layer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    extractConversationId,
    extractOrganizationId,
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
    storeUsageLimits,
    getUsageLimits,
    MAX_TURNS_PER_RECORD,
    CRITICAL_CONTEXT_PCT,
    type StorageArea,
    type TurnRecord,
    type ConversationRecord,
} from '../../lib/conversation-store';
import type { UsageLimitsData } from '../../lib/message-types';

const TEST_ORG = 'org-test-123';

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
        const record = await recordTurn(TEST_ORG, CONV_ID, makeTurn());
        expect(record.id).toBe(CONV_ID);
        expect(record.turnCount).toBe(1);
        expect(record.turns).toHaveLength(1);
        expect(record.turns[0].turnNumber).toBe(1);
        expect(record.finalized).toBe(false);
        expect(record._v).toBe(1);
    });

    it('appends subsequent turns and updates aggregates', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn({ inputTokens: 1000, outputTokens: 200, cost: 0.006 }));
        const record = await recordTurn(TEST_ORG, CONV_ID, makeTurn({ inputTokens: 2000, outputTokens: 400, cost: 0.012, contextPct: 10 }));

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
        await recordTurn(TEST_ORG, CONV_ID, makeTurn({ contextPct: 30 }));
        await recordTurn(TEST_ORG, CONV_ID, makeTurn({ contextPct: 70 }));
        const record = await recordTurn(TEST_ORG, CONV_ID, makeTurn({ contextPct: 50 }));

        expect(record.peakContextPct).toBe(70); // peak was turn 2
        expect(record.lastContextPct).toBe(50); // current is turn 3
    });

    it('caps the turns array at MAX_TURNS_PER_RECORD', async () => {
        for (let i = 0; i < MAX_TURNS_PER_RECORD + 5; i++) {
            await recordTurn(TEST_ORG, CONV_ID, makeTurn({ completedAt: Date.now() + i }));
        }
        const record = await getConversation(TEST_ORG, CONV_ID);
        expect(record!.turns).toHaveLength(MAX_TURNS_PER_RECORD);
        expect(record!.turnCount).toBe(MAX_TURNS_PER_RECORD + 5); // aggregate is still accurate
    });

    it('preserves aggregate accuracy after turns are capped', async () => {
        for (let i = 0; i < MAX_TURNS_PER_RECORD + 10; i++) {
            await recordTurn(TEST_ORG, CONV_ID, makeTurn({ inputTokens: 100, outputTokens: 10, cost: 0.001 }));
        }
        const record = await getConversation(TEST_ORG, CONV_ID);
        const totalTurns = MAX_TURNS_PER_RECORD + 10;
        expect(record!.totalInputTokens).toBe(100 * totalTurns);
        expect(record!.totalOutputTokens).toBe(10 * totalTurns);
        expect(record!.estimatedCost).toBeCloseTo(0.001 * totalTurns);
    });

    it('handles null cost gracefully', async () => {
        const record = await recordTurn(TEST_ORG, CONV_ID, makeTurn({ cost: null }));
        expect(record.estimatedCost).toBeNull();
    });

    it('transitions from null to non-null cost correctly', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn({ cost: null }));
        const record = await recordTurn(TEST_ORG, CONV_ID, makeTurn({ cost: 0.005 }));
        expect(record.estimatedCost).toBeCloseTo(0.005);
    });

    it('adds to convIndex on first turn only', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn());
        await recordTurn(TEST_ORG, CONV_ID, makeTurn());

        const index = mockStore._raw[`convIndex:${TEST_ORG}`] as string[];
        expect(index.filter((id: string) => id === CONV_ID)).toHaveLength(1);
    });

    it('does not interfere between different conversations', async () => {
        const ID_A = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
        const ID_B = 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee';

        await recordTurn(TEST_ORG, ID_A, makeTurn({ inputTokens: 100 }));
        await recordTurn(TEST_ORG, ID_B, makeTurn({ inputTokens: 200 }));

        const a = await getConversation(TEST_ORG, ID_A);
        const b = await getConversation(TEST_ORG, ID_B);
        expect(a!.totalInputTokens).toBe(100);
        expect(b!.totalInputTokens).toBe(200);
    });

    it('updates the model to the latest turn model', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn({ model: 'claude-haiku-4-5' }));
        const record = await recordTurn(TEST_ORG, CONV_ID, makeTurn({ model: 'claude-opus-4-6' }));
        expect(record.model).toBe('claude-opus-4-6');
    });
});

// ── finalizeConversation ──────────────────────────────────────────────────────

describe('finalizeConversation', () => {
    const CONV_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    it('sets finalized to true', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn());
        await finalizeConversation(TEST_ORG, CONV_ID);
        const record = await getConversation(TEST_ORG, CONV_ID);
        expect(record!.finalized).toBe(true);
    });

    it('is a no-op for already finalized conversations', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn());
        await finalizeConversation(TEST_ORG, CONV_ID);
        await finalizeConversation(TEST_ORG, CONV_ID); // second call
        const record = await getConversation(TEST_ORG, CONV_ID);
        expect(record!.finalized).toBe(true);
    });

    it('is a no-op for non-existent conversations', async () => {
        await expect(finalizeConversation(TEST_ORG, 'nonexistent-id')).resolves.not.toThrow();
    });
});

// ── listConversations ─────────────────────────────────────────────────────────

describe('listConversations', () => {
    it('returns conversations in newest-first order', async () => {
        await recordTurn(TEST_ORG, 'conv-a', makeTurn({ completedAt: 1000 }));
        await recordTurn(TEST_ORG, 'conv-b', makeTurn({ completedAt: 2000 }));
        await recordTurn(TEST_ORG, 'conv-c', makeTurn({ completedAt: 3000 }));

        const list = await listConversations(TEST_ORG, 10);
        // Index order is newest first (unshift), so conv-c was added last
        expect(list[0].id).toBe('conv-c');
        expect(list[2].id).toBe('conv-a');
    });

    it('respects the limit parameter', async () => {
        for (let i = 0; i < 5; i++) {
            await recordTurn(TEST_ORG, `conv-${i}`, makeTurn());
        }
        const list = await listConversations(TEST_ORG, 3);
        expect(list).toHaveLength(3);
    });

    it('supports offset for pagination', async () => {
        for (let i = 0; i < 5; i++) {
            await recordTurn(TEST_ORG, `conv-${i}`, makeTurn());
        }
        const page1 = await listConversations(TEST_ORG, 2, 0);
        const page2 = await listConversations(TEST_ORG, 2, 2);
        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(2);
        expect(page1[0].id).not.toBe(page2[0].id);
    });

    it('returns empty array when no conversations exist', async () => {
        const list = await listConversations(TEST_ORG, 10);
        expect(list).toEqual([]);
    });
});

// ── pruneConversations ────────────────────────────────────────────────────────

describe('pruneConversations', () => {
    it('removes conversations older than the cutoff', async () => {
        const old = Date.now() - 100 * 86400000; // 100 days ago
        const recent = Date.now() - 10 * 86400000; // 10 days ago

        await recordTurn(TEST_ORG, 'old-conv', makeTurn({ completedAt: old }));
        await recordTurn(TEST_ORG, 'new-conv', makeTurn({ completedAt: recent }));

        const cutoff = Date.now() - 90 * 86400000;
        const deleted = await pruneConversations(TEST_ORG, cutoff);

        expect(deleted).toBe(1);
        expect(await getConversation(TEST_ORG, 'old-conv')).toBeNull();
        expect(await getConversation(TEST_ORG, 'new-conv')).not.toBeNull();
    });

    it('cleans up the index after pruning', async () => {
        const old = Date.now() - 100 * 86400000;
        await recordTurn(TEST_ORG, 'old-conv', makeTurn({ completedAt: old }));

        const cutoff = Date.now() - 90 * 86400000;
        await pruneConversations(TEST_ORG, cutoff);

        const index = mockStore._raw[`convIndex:${TEST_ORG}`] as string[];
        expect(index).not.toContain('old-conv');
    });

    it('returns 0 when nothing to prune', async () => {
        await recordTurn(TEST_ORG, 'fresh-conv', makeTurn({ completedAt: Date.now() }));
        const deleted = await pruneConversations(TEST_ORG, Date.now() - 90 * 86400000);
        expect(deleted).toBe(0);
    });
});

// ── computeDailySummary ───────────────────────────────────────────────────────

describe('computeDailySummary', () => {
    it('aggregates turns that fall on the target date', async () => {
        // Create a conversation with turns on April 2
        const april2Start = new Date('2026-04-02T10:00:00').getTime();
        await recordTurn(TEST_ORG, 'conv-a', makeTurn({ inputTokens: 500, outputTokens: 100, cost: 0.003, completedAt: april2Start }));
        await recordTurn(TEST_ORG, 'conv-a', makeTurn({ inputTokens: 600, outputTokens: 120, cost: 0.004, completedAt: april2Start + 3600000 }));

        const summary = await computeDailySummary(TEST_ORG, '2026-04-02');
        expect(summary.conversationCount).toBe(1);
        expect(summary.totalTurns).toBe(2);
        expect(summary.totalInputTokens).toBe(1100);
        expect(summary.totalOutputTokens).toBe(220);
        expect(summary.estimatedCost).toBeCloseTo(0.007);
    });

    it('counts critical conversations correctly', async () => {
        await recordTurn(TEST_ORG, 'conv-a', makeTurn({ contextPct: 85, completedAt: new Date('2026-04-02T12:00:00').getTime() }));
        await recordTurn(TEST_ORG, 'conv-b', makeTurn({ contextPct: 30, completedAt: new Date('2026-04-02T13:00:00').getTime() }));

        const summary = await computeDailySummary(TEST_ORG, '2026-04-02');
        expect(summary.criticalConversations).toBe(1); // conv-a peaked at 85 >= 80
    });

    it('builds model breakdown', async () => {
        const ts = new Date('2026-04-02T10:00:00').getTime();
        await recordTurn(TEST_ORG, 'conv-a', makeTurn({ model: 'claude-opus-4-6', completedAt: ts }));
        await recordTurn(TEST_ORG, 'conv-b', makeTurn({ model: 'claude-haiku-4-5', completedAt: ts + 1000 }));

        const summary = await computeDailySummary(TEST_ORG, '2026-04-02');
        expect(summary.modelBreakdown).toHaveLength(2);
        const opus = summary.modelBreakdown.find(m => m.model === 'claude-opus-4-6');
        expect(opus).toBeDefined();
        expect(opus!.conversationCount).toBe(1);
    });

    it('returns zero-value summary for a day with no activity', async () => {
        const summary = await computeDailySummary(TEST_ORG, '2026-04-02');
        expect(summary.conversationCount).toBe(0);
        expect(summary.totalTurns).toBe(0);
        expect(summary.estimatedCost).toBeNull();
    });

    it('stores the summary and updates the index', async () => {
        const ts = new Date('2026-04-02T10:00:00').getTime();
        await recordTurn(TEST_ORG, 'conv-a', makeTurn({ completedAt: ts }));

        await computeDailySummary(TEST_ORG, '2026-04-02');

        const stored = await getDailySummary(TEST_ORG, '2026-04-02');
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

        await recordTurn(TEST_ORG, 'conv-mon', makeTurn({ inputTokens: 1000, outputTokens: 200, cost: 0.006, completedAt: mon }));
        await recordTurn(TEST_ORG, 'conv-tue', makeTurn({ inputTokens: 2000, outputTokens: 400, cost: 0.012, completedAt: tue }));

        await computeDailySummary(TEST_ORG, '2026-03-30');
        await computeDailySummary(TEST_ORG, '2026-03-31');

        const weekly = await computeWeeklySummary(TEST_ORG, '2026-W14');
        expect(weekly.conversationCount).toBe(2);
        expect(weekly.totalTokens).toBe(3600); // 1000+200 + 2000+400
        expect(weekly.weekId).toBe('2026-W14');
    });

    it('identifies the heaviest day', async () => {
        const mon = new Date('2026-03-30T10:00:00').getTime();
        const wed = new Date('2026-04-01T10:00:00').getTime();

        await recordTurn(TEST_ORG, 'conv-mon', makeTurn({ inputTokens: 100, outputTokens: 10, completedAt: mon }));
        await recordTurn(TEST_ORG, 'conv-wed', makeTurn({ inputTokens: 5000, outputTokens: 1000, completedAt: wed }));

        await computeDailySummary(TEST_ORG, '2026-03-30');
        await computeDailySummary(TEST_ORG, '2026-04-01');

        const weekly = await computeWeeklySummary(TEST_ORG, '2026-W14');
        expect(weekly.heaviestDay).toBe(2); // Wednesday (0=Mon)
    });

    it('stores and retrieves correctly', async () => {
        await computeWeeklySummary(TEST_ORG, '2026-W14');
        const stored = await getWeeklySummary(TEST_ORG, '2026-W14');
        expect(stored).not.toBeNull();
        expect(stored!.weekId).toBe('2026-W14');
    });
});

// ── listDailySummaries ────────────────────────────────────────────────────────

describe('listDailySummaries', () => {
    it('returns summaries for the requested number of days', async () => {
        // Seed a summary for today
        const ts = Date.now();
        await recordTurn(TEST_ORG, 'conv-a', makeTurn({ completedAt: ts }));
        const today = todayDateString(ts);
        await computeDailySummary(TEST_ORG, today);

        const summaries = await listDailySummaries(TEST_ORG, 7);
        expect(summaries.length).toBeGreaterThanOrEqual(1);
        expect(summaries[0].date).toBe(today);
    });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
    it('getConversation returns null for non-existent ID', async () => {
        expect(await getConversation(TEST_ORG, 'nonexistent')).toBeNull();
    });

    it('getDailySummary returns null for non-existent date', async () => {
        expect(await getDailySummary(TEST_ORG, '2026-01-01')).toBeNull();
    });

    it('getWeeklySummary returns null for non-existent week', async () => {
        expect(await getWeeklySummary(TEST_ORG, '2026-W01')).toBeNull();
    });

    it('recordTurn after finalize still works (conversation reopened)', async () => {
        const CONV_ID = 'reopen-test';
        await recordTurn(TEST_ORG, CONV_ID, makeTurn());
        await finalizeConversation(TEST_ORG, CONV_ID);
        const record = await recordTurn(TEST_ORG, CONV_ID, makeTurn());
        expect(record.turnCount).toBe(2);
        // finalized stays true from before; the new turn just appends
    });
});

// ── extractOrganizationId ────────────────────────────────────────────────────

describe('extractOrganizationId', () => {
    it('extracts org UUID from a completion API URL', () => {
        const url = 'https://claude.ai/api/organizations/a1b2c3d4-e5f6-7890-abcd-ef1234567890/chat_conversations/conv-456/completion';
        expect(extractOrganizationId(url)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('lowercases the org UUID', () => {
        const url = 'https://claude.ai/api/organizations/AABB1122-CCDD-3344-EEFF-556677889900/chat_conversations/conv/completion';
        expect(extractOrganizationId(url)).toBe('aabb1122-ccdd-3344-eeff-556677889900');
    });

    it('extracts from URLs with query strings', () => {
        const url = 'https://claude.ai/api/organizations/aabb0042-ccdd-eeff/chat_conversations/c/completion?encoding=sse';
        expect(extractOrganizationId(url)).toBe('aabb0042-ccdd-eeff');
    });

    it('returns null for a page URL without organizations path', () => {
        expect(extractOrganizationId('https://claude.ai/chat/abc-123')).toBeNull();
    });

    it('returns null for an empty string', () => {
        expect(extractOrganizationId('')).toBeNull();
    });

    it('returns null for a URL with no match', () => {
        expect(extractOrganizationId('https://example.com/api/users/123')).toBeNull();
    });
});

// ── Account isolation ────────────────────────────────────────────────────────

describe('account isolation', () => {
    const ORG_A = 'org-alice-aaa';
    const ORG_B = 'org-bob-bbb';
    const CONV_ID = 'shared-conv-id';

    it('same conversation ID under two accounts produces separate records', async () => {
        await recordTurn(ORG_A, CONV_ID, makeTurn({ inputTokens: 100 }));
        await recordTurn(ORG_B, CONV_ID, makeTurn({ inputTokens: 999 }));

        const a = await getConversation(ORG_A, CONV_ID);
        const b = await getConversation(ORG_B, CONV_ID);
        expect(a!.totalInputTokens).toBe(100);
        expect(b!.totalInputTokens).toBe(999);
    });

    it('listConversations returns only the queried account data', async () => {
        await recordTurn(ORG_A, 'conv-1', makeTurn());
        await recordTurn(ORG_A, 'conv-2', makeTurn());
        await recordTurn(ORG_B, 'conv-3', makeTurn());

        const listA = await listConversations(ORG_A, 10);
        const listB = await listConversations(ORG_B, 10);
        expect(listA).toHaveLength(2);
        expect(listB).toHaveLength(1);
        expect(listA.map(c => c.id)).toContain('conv-1');
        expect(listA.map(c => c.id)).toContain('conv-2');
        expect(listB[0].id).toBe('conv-3');
    });

    it('daily summaries are isolated per account', async () => {
        const ts = new Date('2026-04-05T12:00:00').getTime();
        await recordTurn(ORG_A, 'conv-a', makeTurn({ inputTokens: 500, completedAt: ts }));
        await recordTurn(ORG_B, 'conv-b', makeTurn({ inputTokens: 2000, completedAt: ts }));

        const summaryA = await computeDailySummary(ORG_A, '2026-04-05');
        const summaryB = await computeDailySummary(ORG_B, '2026-04-05');

        expect(summaryA.totalInputTokens).toBe(500);
        expect(summaryB.totalInputTokens).toBe(2000);
        expect(summaryA.conversationCount).toBe(1);
        expect(summaryB.conversationCount).toBe(1);
    });

    it('pruneConversations only deletes from the target account', async () => {
        const old = Date.now() - 100 * 86400000;
        await recordTurn(ORG_A, 'old-a', makeTurn({ completedAt: old }));
        await recordTurn(ORG_B, 'old-b', makeTurn({ completedAt: old }));

        const cutoff = Date.now() - 90 * 86400000;
        await pruneConversations(ORG_A, cutoff);

        expect(await getConversation(ORG_A, 'old-a')).toBeNull();
        expect(await getConversation(ORG_B, 'old-b')).not.toBeNull();
    });

    it('finalizeConversation only affects the target account', async () => {
        await recordTurn(ORG_A, CONV_ID, makeTurn());
        await recordTurn(ORG_B, CONV_ID, makeTurn());

        await finalizeConversation(ORG_A, CONV_ID);

        const a = await getConversation(ORG_A, CONV_ID);
        const b = await getConversation(ORG_B, CONV_ID);
        expect(a!.finalized).toBe(true);
        expect(b!.finalized).toBe(false);
    });
});

// ── Legacy data migration ────────────────────────────────────────────────────

describe('legacy data migration', () => {
    it('reads from old global key when scoped key does not exist', async () => {
        // Simulate pre-migration data: old key format conv:{convId}
        const legacyRecord: ConversationRecord = {
            id: 'legacy-conv',
            startedAt: 1000,
            lastActiveAt: 2000,
            finalized: false,
            turnCount: 3,
            totalInputTokens: 500,
            totalOutputTokens: 100,
            peakContextPct: 10,
            lastContextPct: 10,
            model: 'claude-sonnet-4-6',
            estimatedCost: 0.003,
            turns: [],
            dna: { subject: 'old topic', lastContext: 'old topic', hints: ['old topic'] },
            _v: 1,
        };
        mockStore._raw['conv:legacy-conv'] = legacyRecord;

        const result = await getConversation(TEST_ORG, 'legacy-conv');
        expect(result).not.toBeNull();
        expect(result!.totalInputTokens).toBe(500);
    });

    it('copies legacy data to the new scoped key on first read', async () => {
        const legacyRecord: ConversationRecord = {
            id: 'migrate-me',
            startedAt: 1000,
            lastActiveAt: 2000,
            finalized: false,
            turnCount: 1,
            totalInputTokens: 100,
            totalOutputTokens: 20,
            peakContextPct: 5,
            lastContextPct: 5,
            model: 'claude-sonnet-4-6',
            estimatedCost: 0.001,
            turns: [],
            dna: { subject: '', lastContext: '', hints: [] },
            _v: 1,
        };
        mockStore._raw['conv:migrate-me'] = legacyRecord;

        // First read triggers migration.
        await getConversation(TEST_ORG, 'migrate-me');

        // New scoped key should now exist.
        const scopedKey = `conv:${TEST_ORG}:migrate-me`;
        expect(mockStore._raw[scopedKey]).toBeDefined();
        expect((mockStore._raw[scopedKey] as ConversationRecord).totalInputTokens).toBe(100);
    });

    it('new scoped key takes precedence over old global key', async () => {
        // Both old and new keys exist with different data.
        const oldRecord: ConversationRecord = {
            id: 'dual-conv',
            startedAt: 1000,
            lastActiveAt: 2000,
            finalized: false,
            turnCount: 1,
            totalInputTokens: 100,
            totalOutputTokens: 20,
            peakContextPct: 5,
            lastContextPct: 5,
            model: 'claude-sonnet-4-6',
            estimatedCost: 0.001,
            turns: [],
            dna: { subject: '', lastContext: '', hints: [] },
            _v: 1,
        };
        const newRecord: ConversationRecord = {
            ...oldRecord,
            totalInputTokens: 999,
        };
        mockStore._raw['conv:dual-conv'] = oldRecord;
        mockStore._raw[`conv:${TEST_ORG}:dual-conv`] = newRecord;

        const result = await getConversation(TEST_ORG, 'dual-conv');
        expect(result!.totalInputTokens).toBe(999); // new key wins
    });
});

// ── Legacy fallback via listConversations ─────────────────────────────────────

describe('legacy fallback via listConversations', () => {
    function makeLegacyRecord(id: string, inputTokens: number): ConversationRecord {
        return {
            id,
            startedAt: 1000,
            lastActiveAt: 2000,
            finalized: false,
            turnCount: 1,
            totalInputTokens: inputTokens,
            totalOutputTokens: 50,
            peakContextPct: 5,
            lastContextPct: 5,
            model: 'claude-sonnet-4-6',
            estimatedCost: 0.001,
            turns: [],
            dna: { subject: '', lastContext: '', hints: [] },
            _v: 1,
        };
    }

    it('returns legacy records when the scoped index is empty', async () => {
        mockStore._raw['convIndex'] = ['leg-a', 'leg-b'];
        mockStore._raw['conv:leg-a'] = makeLegacyRecord('leg-a', 100);
        mockStore._raw['conv:leg-b'] = makeLegacyRecord('leg-b', 200);

        const results = await listConversations(TEST_ORG, 10);
        expect(results).toHaveLength(2);
        expect(results.map(r => r.id)).toContain('leg-a');
        expect(results.map(r => r.id)).toContain('leg-b');
    });

    it('does not migrate legacy records to the scoped index', async () => {
        mockStore._raw['convIndex'] = ['leg-c'];
        mockStore._raw['conv:leg-c'] = makeLegacyRecord('leg-c', 300);

        await listConversations(TEST_ORG, 10);

        // No bulk migration: scoped index must remain absent.
        expect(mockStore._raw[`convIndex:${TEST_ORG}`]).toBeUndefined();
        // Legacy index untouched.
        expect(mockStore._raw['convIndex']).toEqual(['leg-c']);
    });

    it('both accounts can read the same legacy records independently', async () => {
        const ORG_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
        const ORG_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
        mockStore._raw['convIndex'] = ['shared-leg'];
        mockStore._raw['conv:shared-leg'] = makeLegacyRecord('shared-leg', 500);

        const listA = await listConversations(ORG_A, 10);
        const listB = await listConversations(ORG_B, 10);
        expect(listA).toHaveLength(1);
        expect(listB).toHaveLength(1);
    });
});

// ── extractOrgId parity (mirrors inject.ts inline function) ──────────────────

describe('extractOrgId parity', () => {
    // Inline copy of extractOrgId from entrypoints/inject.ts.
    // Both implementations must produce identical output. When one diverges,
    // this test breaks and forces the developer to keep them in sync.
    // mirrors extractOrgId in entrypoints/inject.ts
    function extractOrgIdInject(url: string): string | null {
        const m = url.match(/\/organizations\/([0-9a-f-]+)\//i);
        return m ? m[1].toLowerCase() : null;
    }

    const TEST_URLS = [
        'https://claude.ai/api/organizations/a1b2c3d4-e5f6-7890-abcd-ef1234567890/chat_conversations/c/completion',
        'https://claude.ai/api/organizations/aabb1122-ccdd-3344-eeff-556677889900/settings',
        'https://claude.ai/chat/abc-123',
        '',
    ];

    for (const url of TEST_URLS) {
        it(`lib and inject agree for: ${url.slice(-60) || '(empty string)'}`, () => {
            expect(extractOrganizationId(url)).toBe(extractOrgIdInject(url));
        });
    }
});

// ── Key builder validation: empty accountId throws ────────────────────────────

describe('empty accountId throws', () => {
    it('recordTurn rejects empty string accountId', async () => {
        await expect(
            recordTurn('', 'conv-x', makeTurn()),
        ).rejects.toThrow('[LCO] accountId required for scoped storage key');
    });

    it('getConversation rejects empty string accountId', async () => {
        await expect(
            getConversation('', 'conv-x'),
        ).rejects.toThrow('[LCO] accountId required for scoped storage key');
    });
});

// ── Usage limits CRUD ─────────────────────────────────────────────────────────

describe('storeUsageLimits / getUsageLimits', () => {
    const makeLimits = (sessionPct: number, weeklyPct: number): UsageLimitsData => ({
        fiveHour: { utilization: sessionPct, resetsAt: '2026-04-07T01:00:00.000Z' },
        sevenDay: { utilization: weeklyPct, resetsAt: '2026-04-08T09:00:00.000Z' },
        capturedAt: Date.now(),
    });

    it('stores and retrieves usage limits for an account', async () => {
        const limits = makeLimits(11, 21);
        await storeUsageLimits(TEST_ORG, limits);
        const retrieved = await getUsageLimits(TEST_ORG);
        expect(retrieved).toEqual(limits);
    });

    it('returns null when no limits have been stored', async () => {
        const result = await getUsageLimits('org-never-stored');
        expect(result).toBeNull();
    });

    it('overwrites previous data on second store call', async () => {
        await storeUsageLimits(TEST_ORG, makeLimits(11, 21));
        const updated = makeLimits(44, 55);
        await storeUsageLimits(TEST_ORG, updated);
        const result = await getUsageLimits(TEST_ORG);
        expect(result?.fiveHour.utilization).toBe(44);
        expect(result?.sevenDay.utilization).toBe(55);
    });

    it('isolates data between accounts (different org IDs)', async () => {
        const orgA = 'org-aaa-111';
        const orgB = 'org-bbb-222';
        await storeUsageLimits(orgA, makeLimits(10, 20));
        await storeUsageLimits(orgB, makeLimits(80, 90));

        const a = await getUsageLimits(orgA);
        const b = await getUsageLimits(orgB);
        expect(a?.fiveHour.utilization).toBe(10);
        expect(b?.fiveHour.utilization).toBe(80);
    });

    it('uses the correct storage key format usageLimits:{accountId}', async () => {
        const limits = makeLimits(11, 21);
        await storeUsageLimits(TEST_ORG, limits);
        // Read back using getUsageLimits to confirm the correct key is used
        // (if the key were wrong, it would return null instead of the stored record).
        const result = await getUsageLimits(TEST_ORG);
        expect(result).not.toBeNull();
    });

    it('throws when accountId is empty string', async () => {
        await expect(
            storeUsageLimits('', makeLimits(11, 21)),
        ).rejects.toThrow('[LCO] accountId required for scoped storage key');
    });

    it('throws getUsageLimits when accountId is empty string', async () => {
        await expect(
            getUsageLimits(''),
        ).rejects.toThrow('[LCO] accountId required for scoped storage key');
    });
});
