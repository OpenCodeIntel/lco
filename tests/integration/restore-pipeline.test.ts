// tests/integration/restore-pipeline.test.ts
// End-to-end integration tests for the context state restoration pipeline.
// Exercises the full flow: stored record -> applyRestoredConversation ->
// buildConvStateFromRecord -> cumulative tracking -> STREAM_COMPLETE update.

import { describe, it, expect } from 'vitest';
import { INITIAL_STATE, applyRestoredConversation, applyStreamComplete } from '../../lib/overlay-state';
import type { OverlayState } from '../../lib/overlay-state';
import type { ConversationRecord } from '../../lib/conversation-store';
import { EMPTY_DNA } from '../../lib/conversation-store';
import { getContextWindowSize, calculateCost } from '../../lib/pricing';
import { computeHealthScore, computeGrowthRate, type HealthScore } from '../../lib/health-score';
import type { ConversationState } from '../../lib/context-intelligence';

// -- Helpers (mirror content script logic) --

function buildConvStateFromRecord(record: ConversationRecord, contextPct: number): ConversationState {
    return {
        turnCount: record.turnCount,
        contextPct,
        contextHistory: record.turns.map(() => contextPct),
        model: record.model,
        contextWindow: getContextWindowSize(record.model) || 200000,
    };
}

function computeCumulativeContextPct(input: number, output: number, model: string): number {
    const ctxWindow = getContextWindowSize(model) || 200000;
    return ctxWindow > 0 ? ((input + output) / ctxWindow) * 100 : 0;
}

/** Simulate the full restore flow from the content script. */
function restoreConversation(record: ConversationRecord): {
    state: OverlayState;
    convState: ConversationState;
    cumulativeInput: number;
    cumulativeOutput: number;
    cumulativeCost: number;
} {
    const cumulativeInput = record.totalInputTokens;
    const cumulativeOutput = record.totalOutputTokens;
    const cumulativeCost = record.estimatedCost ?? 0;

    let state = applyRestoredConversation(INITIAL_STATE, record, null);
    const convState = buildConvStateFromRecord(record, state.contextPct ?? 0);
    const health = computeHealthScore({
        contextPct: convState.contextPct,
        turnCount: convState.turnCount,
        growthRate: computeGrowthRate(convState.contextHistory),
        model: convState.model,
        isDetailHeavy: false,
    });
    state = { ...state, health };

    return { state, convState, cumulativeInput, cumulativeOutput, cumulativeCost };
}

/** Simulate a STREAM_COMPLETE arriving after restore. */
function applyStreamCompleteAfterRestore(
    current: ReturnType<typeof restoreConversation>,
    msg: { inputTokens: number; outputTokens: number; model: string },
): {
    state: OverlayState;
    convState: ConversationState;
    cumulativeInput: number;
    cumulativeOutput: number;
    cumulativeCost: number;
} {
    const cumulativeInput = current.cumulativeInput + msg.inputTokens;
    const cumulativeOutput = current.cumulativeOutput + msg.outputTokens;
    const msgCost = calculateCost(msg.inputTokens, msg.outputTokens, msg.model) ?? 0;
    const cumulativeCost = current.cumulativeCost + msgCost;

    const ctxWindow = getContextWindowSize(msg.model) || 200000;
    const cumulativeContextPct = ctxWindow > 0
        ? ((cumulativeInput + cumulativeOutput) / ctxWindow) * 100
        : 0;

    const convState: ConversationState = {
        turnCount: current.convState.turnCount + 1,
        contextPct: cumulativeContextPct,
        contextHistory: [...current.convState.contextHistory, cumulativeContextPct],
        model: msg.model,
        contextWindow: ctxWindow,
    };

    const state: OverlayState = {
        ...applyStreamComplete(current.state, msg),
        contextPct: cumulativeContextPct,
        session: {
            requestCount: convState.turnCount,
            totalInputTokens: cumulativeInput,
            totalOutputTokens: cumulativeOutput,
            totalCost: cumulativeCost,
        },
        health: computeHealthScore({
            contextPct: cumulativeContextPct,
            turnCount: convState.turnCount,
            growthRate: computeGrowthRate(convState.contextHistory),
            model: msg.model,
            isDetailHeavy: false,
        }),
    };

    return { state, convState, cumulativeInput, cumulativeOutput, cumulativeCost };
}

// -- Test data --

function makeRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
    return {
        id: 'conv-123',
        startedAt: Date.now() - 3600_000,
        lastActiveAt: Date.now(),
        finalized: false,
        turnCount: 15,
        totalInputTokens: 3000,
        totalOutputTokens: 1100,
        peakContextPct: 2.05,
        lastContextPct: 0.01,
        model: 'claude-haiku-4-5',
        estimatedCost: 0.025,
        turns: Array.from({ length: 15 }, (_, i) => ({
            turnNumber: i + 1,
            inputTokens: 200,
            outputTokens: 73,
            model: 'claude-haiku-4-5',
            contextPct: 0.001,
            cost: 0.002,
            completedAt: Date.now() - (15 - i) * 60000,
        })),
        dna: { ...EMPTY_DNA },
        _v: 1,
        ...overrides,
    };
}

// ── Full restore flow ────────────────────────────────────────────────────────

describe('restore pipeline: full flow', () => {
    it('produces correct overlay state from a stored record', () => {
        const record = makeRecord();
        const { state, convState } = restoreConversation(record);

        // contextPct = (3000 + 1100) / 200000 * 100 = 2.05%
        expect(state.contextPct).toBeCloseTo(2.05, 2);
        expect(state.session.requestCount).toBe(15);
        expect(state.session.totalInputTokens).toBe(3000);
        expect(state.session.totalOutputTokens).toBe(1100);
        expect(state.session.totalCost).toBe(0.025);
        expect(state.health).not.toBeNull();
        expect(state.health?.level).toBe('healthy');

        // ConversationState should match
        expect(convState.turnCount).toBe(15);
        expect(convState.contextPct).toBeCloseTo(2.05, 2);
        expect(convState.contextHistory).toHaveLength(15);
    });

    it('preserves lastRequest as null (no live data yet)', () => {
        const { state } = restoreConversation(makeRecord());
        expect(state.lastRequest).toBeNull();
    });

    it('preserves streaming as false', () => {
        const { state } = restoreConversation(makeRecord());
        expect(state.streaming).toBe(false);
    });
});

// ── Null/edge cases ──────────────────────────────────────────────────────────

describe('restore pipeline: edge cases', () => {
    it('handles null estimatedCost: cumulativeCost starts at 0', () => {
        const record = makeRecord({ estimatedCost: null as unknown as number });
        const { cumulativeCost, state } = restoreConversation(record);

        expect(cumulativeCost).toBe(0);
        // session.totalCost comes from record.estimatedCost (null)
        expect(state.session.totalCost).toBeNull();
    });

    it('handles record with zero tokens', () => {
        const record = makeRecord({ totalInputTokens: 0, totalOutputTokens: 0, turnCount: 1 });
        const { state } = restoreConversation(record);

        expect(state.contextPct).toBe(0);
        expect(state.session.totalInputTokens).toBe(0);
    });

    it('handles record with very large token counts', () => {
        const record = makeRecord({
            totalInputTokens: 150000,
            totalOutputTokens: 45000,
        });
        const { state } = restoreConversation(record);

        // 195000 / 200000 * 100 = 97.5%
        expect(state.contextPct).toBeCloseTo(97.5, 1);
    });

    it('handles empty turns array', () => {
        const record = makeRecord({ turns: [], turnCount: 0 });
        const { convState } = restoreConversation(record);

        expect(convState.contextHistory).toEqual([]);
    });
});

// ── Restore then STREAM_COMPLETE ─────────────────────────────────────────────

describe('restore pipeline: restore then stream', () => {
    it('cumulative totals add correctly after restore + new message', () => {
        const record = makeRecord();
        const restored = restoreConversation(record);

        // Simulate a new message: 50 input tokens, 200 output tokens
        const msg = { inputTokens: 50, outputTokens: 200, model: 'claude-haiku-4-5' };
        const after = applyStreamCompleteAfterRestore(restored, msg);

        expect(after.cumulativeInput).toBe(3050);
        expect(after.cumulativeOutput).toBe(1300);
        expect(after.state.session.requestCount).toBe(16);
        expect(after.state.session.totalInputTokens).toBe(3050);
        expect(after.state.session.totalOutputTokens).toBe(1300);

        // contextPct should grow
        expect(after.state.contextPct).toBeGreaterThan(restored.state.contextPct!);
        // (3050 + 1300) / 200000 * 100 = 2.175%
        expect(after.state.contextPct).toBeCloseTo(2.175, 2);
    });

    it('turn count increments by one after each STREAM_COMPLETE', () => {
        const restored = restoreConversation(makeRecord());
        const msg = { inputTokens: 10, outputTokens: 20, model: 'claude-haiku-4-5' };

        const after1 = applyStreamCompleteAfterRestore(restored, msg);
        expect(after1.convState.turnCount).toBe(16);

        const after2 = applyStreamCompleteAfterRestore(after1, msg);
        expect(after2.convState.turnCount).toBe(17);
    });

    it('contextHistory grows with each STREAM_COMPLETE', () => {
        const restored = restoreConversation(makeRecord());
        const msg = { inputTokens: 10, outputTokens: 20, model: 'claude-haiku-4-5' };

        expect(restored.convState.contextHistory).toHaveLength(15);

        const after1 = applyStreamCompleteAfterRestore(restored, msg);
        expect(after1.convState.contextHistory).toHaveLength(16);

        const after2 = applyStreamCompleteAfterRestore(after1, msg);
        expect(after2.convState.contextHistory).toHaveLength(17);
    });

    it('health score updates after STREAM_COMPLETE', () => {
        const restored = restoreConversation(makeRecord());
        const msg = { inputTokens: 10, outputTokens: 20, model: 'claude-haiku-4-5' };

        const after = applyStreamCompleteAfterRestore(restored, msg);
        expect(after.state.health).not.toBeNull();
        expect(after.state.health?.level).toBe('healthy');
    });

    it('cost accumulates correctly across multiple turns', () => {
        const restored = restoreConversation(makeRecord());
        const msg = { inputTokens: 100, outputTokens: 500, model: 'claude-haiku-4-5' };

        const after1 = applyStreamCompleteAfterRestore(restored, msg);
        const after2 = applyStreamCompleteAfterRestore(after1, msg);

        const msgCost = calculateCost(100, 500, 'claude-haiku-4-5') ?? 0;
        expect(after2.cumulativeCost).toBeCloseTo(0.025 + msgCost * 2, 6);
    });
});

// ── Navigation reset ─────────────────────────────────────────────────────────

describe('restore pipeline: navigation reset', () => {
    it('fresh state matches INITIAL_STATE defaults', () => {
        // Simulates what happens when navigating to /new (no record)
        const state = { ...INITIAL_STATE };
        expect(state.contextPct).toBeNull();
        expect(state.session.requestCount).toBe(0);
        expect(state.session.totalCost).toBeNull();
        expect(state.lastRequest).toBeNull();
        expect(state.health).toBeNull();
    });
});
