// tests/unit/context-restoration.test.ts
// Tests for the context state restoration pipeline added in LCO-35.
// Covers buildConvStateFromRecord, cumulative contextPct computation,
// and the navGeneration race condition guard.

import { describe, it, expect } from 'vitest';
import { getContextWindowSize } from '../../lib/pricing';
import type { ConversationRecord } from '../../lib/conversation-store';
import { EMPTY_DNA } from '../../lib/conversation-store';
import type { ConversationState } from '../../lib/context-intelligence';

// -- Mirrored buildConvStateFromRecord from claude-ai.content.ts --

function buildConvStateFromRecord(record: ConversationRecord, contextPct: number): ConversationState {
    return {
        turnCount: record.turnCount,
        contextPct,
        contextHistory: record.turns.map(() => contextPct),
        model: record.model,
        contextWindow: getContextWindowSize(record.model) || 200000,
    };
}

// -- Mirrored cumulative contextPct formula from claude-ai.content.ts --

function computeCumulativeContextPct(
    cumulativeInput: number,
    cumulativeOutput: number,
    model: string,
): number {
    const ctxWindow = getContextWindowSize(model) || 200000;
    return ctxWindow > 0 ? ((cumulativeInput + cumulativeOutput) / ctxWindow) * 100 : 0;
}

// -- Mirrored navGeneration guard pattern --

interface RestoreResult {
    applied: boolean;
    contextPct?: number;
}

/**
 * Simulates the async restore + generation guard from navigatesuccess handler.
 * Returns whether the restore was applied or discarded.
 */
async function simulateAsyncRestore(
    currentGeneration: number,
    generationAtCallback: number,
    record: ConversationRecord | null,
): Promise<RestoreResult> {
    if (!record || currentGeneration !== generationAtCallback) {
        return { applied: false };
    }
    const ctxWindow = getContextWindowSize(record.model) || 200000;
    const contextPct = ctxWindow > 0
        ? ((record.totalInputTokens + record.totalOutputTokens) / ctxWindow) * 100
        : 0;
    return { applied: true, contextPct };
}

// -- Test data helpers --

function makeRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
    return {
        id: 'test-conv-id',
        startedAt: Date.now() - 3600_000,
        lastActiveAt: Date.now(),
        finalized: false,
        turnCount: 15,
        totalInputTokens: 3000,
        totalOutputTokens: 1100,
        peakContextPct: 2.05,
        lastContextPct: 0.01, // near-zero from pre-cumulative tracking
        model: 'claude-sonnet-4-6',
        estimatedCost: 0.025,
        turns: [
            { turnNumber: 1, inputTokens: 200, outputTokens: 80, model: 'claude-sonnet-4-6', contextPct: 0.001, cost: 0.002, completedAt: Date.now() - 60000 },
            { turnNumber: 2, inputTokens: 200, outputTokens: 70, model: 'claude-sonnet-4-6', contextPct: 0.001, cost: 0.002, completedAt: Date.now() - 30000 },
        ],
        dna: { ...EMPTY_DNA },
        _v: 1,
        ...overrides,
    };
}

// ── buildConvStateFromRecord ─────────────────────────────────────────────────

describe('buildConvStateFromRecord', () => {
    it('builds ConversationState with correct fields from record', () => {
        const record = makeRecord();
        const result = buildConvStateFromRecord(record, 2.05);

        expect(result.turnCount).toBe(15);
        expect(result.contextPct).toBe(2.05);
        expect(result.model).toBe('claude-sonnet-4-6');
    });

    it('backfills contextHistory with the passed contextPct value', () => {
        const record = makeRecord();
        const result = buildConvStateFromRecord(record, 5.0);

        // Every entry should be the passed contextPct, not the stored per-turn values
        expect(result.contextHistory).toHaveLength(2);
        expect(result.contextHistory.every(v => v === 5.0)).toBe(true);
    });

    it('uses getContextWindowSize for known models', () => {
        const record = makeRecord({ model: 'claude-haiku-4-5' });
        const result = buildConvStateFromRecord(record, 1.0);

        // Haiku 4.5 has a 200k context window
        expect(result.contextWindow).toBe(200000);
    });

    it('falls back to 200k for unknown models', () => {
        const record = makeRecord({ model: 'unknown-model-xyz' });
        const result = buildConvStateFromRecord(record, 1.0);

        expect(result.contextWindow).toBe(200000);
    });

    it('handles empty turns array', () => {
        const record = makeRecord({ turns: [] });
        const result = buildConvStateFromRecord(record, 3.0);

        expect(result.contextHistory).toEqual([]);
    });

    it('does not use record.lastContextPct (ignores stored per-turn values)', () => {
        const record = makeRecord({ lastContextPct: 99.99 });
        const result = buildConvStateFromRecord(record, 2.0);

        // contextPct comes from the parameter, not the record
        expect(result.contextPct).toBe(2.0);
    });
});

// ── Cumulative contextPct computation ────────────────────────────────────────

describe('cumulative contextPct computation', () => {
    it('computes percentage from cumulative tokens and context window', () => {
        // 3000 + 1100 = 4100 tokens / 200000 window * 100 = 2.05%
        const pct = computeCumulativeContextPct(3000, 1100, 'claude-sonnet-4-6');
        expect(pct).toBeCloseTo(2.05, 2);
    });

    it('grows with each additional turn', () => {
        const turn1 = computeCumulativeContextPct(200, 100, 'claude-sonnet-4-6');
        const turn2 = computeCumulativeContextPct(400, 200, 'claude-sonnet-4-6');
        const turn3 = computeCumulativeContextPct(600, 300, 'claude-sonnet-4-6');

        expect(turn2).toBeGreaterThan(turn1);
        expect(turn3).toBeGreaterThan(turn2);
    });

    it('returns 0 for zero tokens', () => {
        expect(computeCumulativeContextPct(0, 0, 'claude-sonnet-4-6')).toBe(0);
    });

    it('handles very large token counts without overflow', () => {
        // 180000 input + 19000 output = 199000 / 200000 = 99.5%
        const pct = computeCumulativeContextPct(180000, 19000, 'claude-sonnet-4-6');
        expect(pct).toBeCloseTo(99.5, 1);
    });

    it('defaults to 200k window for unknown models', () => {
        // 1000 + 1000 = 2000 / 200000 = 1%
        const pct = computeCumulativeContextPct(1000, 1000, 'unknown-model');
        expect(pct).toBeCloseTo(1.0, 2);
    });

    it('initializes from stored record on restore', () => {
        const record = makeRecord();
        const pct = computeCumulativeContextPct(
            record.totalInputTokens,
            record.totalOutputTokens,
            record.model,
        );
        // 3000 + 1100 = 4100 / 200000 = 2.05%
        expect(pct).toBeCloseTo(2.05, 2);
    });

    it('accumulates after restore', () => {
        const record = makeRecord();
        const baseInput = record.totalInputTokens;
        const baseOutput = record.totalOutputTokens;

        // Simulate sending a new message: 50 input + 200 output
        const newInput = baseInput + 50;
        const newOutput = baseOutput + 200;
        const pct = computeCumulativeContextPct(newInput, newOutput, record.model);

        // (3050 + 1300) / 200000 * 100 = 2.175%
        expect(pct).toBeCloseTo(2.175, 2);
        expect(pct).toBeGreaterThan(computeCumulativeContextPct(baseInput, baseOutput, record.model));
    });
});

// ── navGeneration race guard ─────────────────────────────────────────────────

describe('navGeneration race guard', () => {
    it('applies restore when generation matches', async () => {
        const result = await simulateAsyncRestore(1, 1, makeRecord());
        expect(result.applied).toBe(true);
        expect(result.contextPct).toBeCloseTo(2.05, 2);
    });

    it('discards restore when generation does not match (stale callback)', async () => {
        // User navigated again before the restore completed
        const result = await simulateAsyncRestore(2, 1, makeRecord());
        expect(result.applied).toBe(false);
        expect(result.contextPct).toBeUndefined();
    });

    it('discards restore when record is null', async () => {
        const result = await simulateAsyncRestore(1, 1, null);
        expect(result.applied).toBe(false);
    });

    it('handles rapid sequential navigations: only last one applies', async () => {
        // Simulate three navigations in quick succession
        const r1 = await simulateAsyncRestore(3, 1, makeRecord({ id: 'conv-1' }));
        const r2 = await simulateAsyncRestore(3, 2, makeRecord({ id: 'conv-2' }));
        const r3 = await simulateAsyncRestore(3, 3, makeRecord({ id: 'conv-3' }));

        expect(r1.applied).toBe(false); // stale
        expect(r2.applied).toBe(false); // stale
        expect(r3.applied).toBe(true);  // current
    });

    it('discards restore when generation is 0 (initial) but current is 1', async () => {
        const result = await simulateAsyncRestore(1, 0, makeRecord());
        expect(result.applied).toBe(false);
    });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('restoration edge cases', () => {
    it('handles record with zero totalInputTokens', () => {
        const record = makeRecord({ totalInputTokens: 0, totalOutputTokens: 500 });
        const pct = computeCumulativeContextPct(
            record.totalInputTokens,
            record.totalOutputTokens,
            record.model,
        );
        // 0 + 500 = 500 / 200000 = 0.25%
        expect(pct).toBeCloseTo(0.25, 2);
    });

    it('handles record with null estimatedCost gracefully', () => {
        const record = makeRecord({ estimatedCost: null as unknown as number });
        // The content script does: cumulativeCost = record.estimatedCost ?? 0
        const cumulativeCost = record.estimatedCost ?? 0;
        expect(cumulativeCost).toBe(0);
    });

    it('produces zero growth rate from flat backfilled history', () => {
        const record = makeRecord();
        const state = buildConvStateFromRecord(record, 2.05);
        // All entries are identical -> growth rate = 0
        const history = state.contextHistory;
        if (history.length < 2) return;
        const diffs = history.slice(1).map((v, i) => v - history[i]);
        const avgGrowth = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        expect(avgGrowth).toBe(0);
    });
});
