// tests/unit/today-rollup.test.ts
// GET-18: TODAY rollup invariants.
// Proves that computeDailySummary always reflects the current state of all
// conversations, so the TODAY card is never behind the active conversation.

import { describe, it, expect, beforeEach } from 'vitest';
import {
    setStorage,
    recordTurn,
    computeDailySummary,
    todayDateString,
    type StorageArea,
} from '../../lib/conversation-store';

const TEST_ORG = 'org-get18';
const CONV_A = 'conv-get18-a';
const CONV_B = 'conv-get18-b';

function createStoreMock(): StorageArea {
    const data: Record<string, unknown> = {};
    return {
        get: async (keys: string | string[] | null) => {
            if (keys === null) return { ...data };
            const keyList = typeof keys === 'string' ? [keys] : keys;
            const result: Record<string, unknown> = {};
            for (const k of keyList) {
                if (k in data) result[k] = data[k];
            }
            return result;
        },
        set: async (items: Record<string, unknown>) => {
            Object.assign(data, items);
        },
        remove: async (keys: string | string[]) => {
            const keyList = typeof keys === 'string' ? [keys] : keys;
            for (const k of keyList) delete data[k];
        },
    };
}

beforeEach(() => {
    setStorage(createStoreMock());
});

describe('GET-18: TODAY rollup invariants', () => {
    it('daily summary totalTurns >= any single conversation contribution', async () => {
        const today = todayDateString();
        const now = Date.now();

        for (let i = 0; i < 5; i++) {
            await recordTurn(TEST_ORG, CONV_A, {
                inputTokens: 100,
                outputTokens: 50,
                model: 'claude-sonnet-4-6',
                contextPct: 5,
                cost: 0.001,
                completedAt: now,
            });
        }

        for (let i = 0; i < 12; i++) {
            await recordTurn(TEST_ORG, CONV_B, {
                inputTokens: 200,
                outputTokens: 80,
                model: 'claude-sonnet-4-6',
                contextPct: 10,
                cost: 0.002,
                completedAt: now,
            });
        }

        const summary = await computeDailySummary(TEST_ORG, today);

        expect(summary.totalTurns).toBe(17);
        expect(summary.totalTurns).toBeGreaterThanOrEqual(12);
        expect(summary.totalTurns).toBeGreaterThanOrEqual(5);
        expect(summary.totalInputTokens).toBeGreaterThanOrEqual(12 * 200);
        expect(summary.estimatedCost).not.toBeNull();
        expect(summary.estimatedCost!).toBeGreaterThanOrEqual(12 * 0.002);
        expect(summary.conversationCount).toBe(2);
    });

    it('computeDailySummary reflects a new turn immediately after recordTurn', async () => {
        const today = todayDateString();
        const now = Date.now();
        const baseTurn = {
            inputTokens: 500,
            outputTokens: 100,
            model: 'claude-sonnet-4-6',
            contextPct: 8,
            cost: 0.005,
            completedAt: now,
        };

        for (let i = 0; i < 3; i++) {
            await recordTurn(TEST_ORG, CONV_A, baseTurn);
        }
        const stale = await computeDailySummary(TEST_ORG, today);
        expect(stale.totalTurns).toBe(3);

        const extraTurn = { ...baseTurn, inputTokens: 800, outputTokens: 150, cost: 0.009 };
        await recordTurn(TEST_ORG, CONV_A, extraTurn);
        const fresh = await computeDailySummary(TEST_ORG, today);

        expect(fresh.totalTurns).toBe(stale.totalTurns + 1);
        expect(fresh.totalInputTokens).toBe(stale.totalInputTokens + extraTurn.inputTokens);
        expect(fresh.totalOutputTokens).toBe(stale.totalOutputTokens + extraTurn.outputTokens);
        expect(fresh.estimatedCost).not.toBeNull();
        expect(fresh.estimatedCost!).toBeCloseTo(stale.estimatedCost! + extraTurn.cost, 6);
    });

    it('no double-counting: two conversations sum to exact totals', async () => {
        const today = todayDateString();
        const now = Date.now();

        for (let i = 0; i < 3; i++) {
            await recordTurn(TEST_ORG, CONV_A, {
                inputTokens: 100,
                outputTokens: 50,
                model: 'claude-haiku-4-5',
                contextPct: 3,
                cost: 0.001,
                completedAt: now,
            });
        }

        for (let i = 0; i < 2; i++) {
            await recordTurn(TEST_ORG, CONV_B, {
                inputTokens: 200,
                outputTokens: 100,
                model: 'claude-haiku-4-5',
                contextPct: 5,
                cost: 0.003,
                completedAt: now,
            });
        }

        const summary = await computeDailySummary(TEST_ORG, today);

        expect(summary.conversationCount).toBe(2);
        expect(summary.totalTurns).toBe(5);
        expect(summary.totalInputTokens).toBe(3 * 100 + 2 * 200);
        expect(summary.totalOutputTokens).toBe(3 * 50 + 2 * 100);
        expect(summary.estimatedCost).not.toBeNull();
        expect(summary.estimatedCost!).toBeCloseTo(3 * 0.001 + 2 * 0.003, 6);
    });
});
