// tests/unit/today-rollup.test.ts
//
// GET-18 invariant: the TODAY daily summary must always be >= the active
// conversation's numbers. computeDailySummary is the function that produces
// this value; these tests prove its correctness properties directly.
//
// Hook integration gap: the useDashboardData.ts change that calls
// computeDailySummary on conv: storage events cannot be unit-tested here
// without renderHook + full Chrome API mocks (not present in this test setup).
// Manual verification covers it: open the side panel mid-conversation and
// confirm TODAY matches ACTIVE CONVERSATION to the exact turn and token count
// within one turn cycle, without waiting for the 30-min background alarm.

import { describe, it, expect, beforeEach } from 'vitest';
import {
    setStorage,
    recordTurn,
    computeDailySummary,
    todayDateString,
    type StorageArea,
} from '../../lib/conversation-store';

const ORG = 'org-get18';
const CONV_A = 'conv-get18-a';
const CONV_B = 'conv-get18-b';

// Inline mock matching the StorageArea interface. Plain async functions are
// sufficient here because these tests assert data values, not call counts.
function makeStoreMock(): StorageArea {
    const data: Record<string, unknown> = {};
    return {
        get: async (keys: string | string[] | null) => {
            if (keys === null) return { ...data };
            const ks = typeof keys === 'string' ? [keys] : keys;
            const out: Record<string, unknown> = {};
            for (const k of ks) if (k in data) out[k] = data[k];
            return out;
        },
        set: async (items: Record<string, unknown>) => { Object.assign(data, items); },
        remove: async (keys: string | string[]) => {
            for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k];
        },
    };
}

beforeEach(() => { setStorage(makeStoreMock()); });

describe('GET-18: TODAY rollup invariants', () => {
    it('sums all conversations, not just the active one', async () => {
        // The naive Math.max(today.totalTurns, activeConv.turnCount) fix is wrong
        // for multi-conversation days: if conv A has 5 turns and conv B (active)
        // has 12, Math.max(17, 12) = 17 when it should be 5+12=17 -- correct by
        // coincidence. But if conv B has fewer turns than the daily total, Math.max
        // silently drops conv A's contribution. computeDailySummary must sum all
        // conversations, so it is immune to that class of bug.
        const now = Date.now();

        for (let i = 0; i < 5; i++) {
            await recordTurn(ORG, CONV_A, {
                inputTokens: 100, outputTokens: 50, model: 'claude-sonnet-4-6',
                contextPct: 5, cost: 0.001, completedAt: now,
            });
        }
        for (let i = 0; i < 12; i++) {
            await recordTurn(ORG, CONV_B, {
                inputTokens: 200, outputTokens: 80, model: 'claude-sonnet-4-6',
                contextPct: 10, cost: 0.002, completedAt: now,
            });
        }

        const summary = await computeDailySummary(ORG, todayDateString());

        expect(summary.totalTurns).toBe(17);                           // 5 + 12, exact
        expect(summary.totalTurns).toBeGreaterThanOrEqual(12);         // invariant: >= conv B
        expect(summary.totalTurns).toBeGreaterThanOrEqual(5);          // invariant: >= conv A
        expect(summary.totalInputTokens).toBeGreaterThanOrEqual(12 * 200);
        expect(summary.estimatedCost).not.toBeNull();
        expect(summary.estimatedCost!).toBeGreaterThanOrEqual(12 * 0.002);
        expect(summary.conversationCount).toBe(2);
    });

    it('reflects a new turn immediately without waiting for the alarm', async () => {
        // Simulates the exact GET-18 scenario: daily summary was last written by
        // the background alarm when the conversation had N turns. One more turn
        // completes. The next computeDailySummary call must include that turn
        // immediately, not on the next 30-min alarm cycle.
        const now = Date.now();
        const base = {
            inputTokens: 500, outputTokens: 100, model: 'claude-sonnet-4-6',
            contextPct: 8, cost: 0.005, completedAt: now,
        };

        for (let i = 0; i < 3; i++) await recordTurn(ORG, CONV_A, base);
        const stale = await computeDailySummary(ORG, todayDateString());

        // One more turn lands (the one the alarm has not seen yet).
        const extra = { ...base, inputTokens: 800, outputTokens: 150, cost: 0.009 };
        await recordTurn(ORG, CONV_A, extra);
        const fresh = await computeDailySummary(ORG, todayDateString());

        expect(fresh.totalTurns).toBe(stale.totalTurns + 1);
        expect(fresh.totalInputTokens).toBe(stale.totalInputTokens + extra.inputTokens);
        expect(fresh.totalOutputTokens).toBe(stale.totalOutputTokens + extra.outputTokens);
        expect(fresh.estimatedCost).not.toBeNull();
        expect(fresh.estimatedCost!).toBeCloseTo(stale.estimatedCost! + extra.cost, 6);
    });

    it('no double-counting when two conversations share a day', async () => {
        // computeDailySummary iterates the conv index and aggregates. A bug that
        // counted the same conv twice would produce 2x totals here. Fixed turn
        // counts make the exact expected values unambiguous.
        const now = Date.now();

        for (let i = 0; i < 3; i++) {
            await recordTurn(ORG, CONV_A, {
                inputTokens: 100, outputTokens: 50, model: 'claude-haiku-4-5',
                contextPct: 3, cost: 0.001, completedAt: now,
            });
        }
        for (let i = 0; i < 2; i++) {
            await recordTurn(ORG, CONV_B, {
                inputTokens: 200, outputTokens: 100, model: 'claude-haiku-4-5',
                contextPct: 5, cost: 0.003, completedAt: now,
            });
        }

        const summary = await computeDailySummary(ORG, todayDateString());

        expect(summary.conversationCount).toBe(2);
        expect(summary.totalTurns).toBe(5);                              // 3 + 2, not 6
        expect(summary.totalInputTokens).toBe(3 * 100 + 2 * 200);       // 700
        expect(summary.totalOutputTokens).toBe(3 * 50 + 2 * 100);       // 350
        expect(summary.estimatedCost).not.toBeNull();
        expect(summary.estimatedCost!).toBeCloseTo(3 * 0.001 + 2 * 0.003, 6);
    });

    it('propagates null estimatedCost when no turn has a known cost', async () => {
        // An unrecognized model returns null from the pricing agent. The daily
        // summary must stay null rather than coercing to 0: null means "cost
        // unknown" and 0 means "this session was free". Conflating the two would
        // silently misreport usage to any downstream consumer (traction exports,
        // BIP posts, YC metrics).
        await recordTurn(ORG, CONV_A, {
            inputTokens: 300, outputTokens: 100, model: 'claude-unknown-future-model',
            contextPct: 5, cost: null, completedAt: Date.now(),
        });

        const summary = await computeDailySummary(ORG, todayDateString());

        expect(summary.estimatedCost).toBeNull();
        expect(summary.totalTurns).toBe(1);
        expect(summary.totalInputTokens).toBe(300);
    });
});
