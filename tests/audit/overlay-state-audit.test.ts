import { describe, test, expect } from 'vitest';

// Audit: lib/overlay-state.ts - state reducer immutability and correctness

import {
    INITIAL_STATE,
    applyTokenBatch,
    applyStreamComplete,
    applyStorageResponse,
    applyHealthBroken,
    applyHealthRecovered,
    applyMessageLimit,
    applyRestoredConversation,
    applyDraftEstimate,
    clearDraftEstimate,
    type OverlayState,
} from '../../lib/overlay-state';
import type { TabState } from '../../lib/message-types';
import type { ConversationRecord } from '../../lib/conversation-store';
import type { HealthScore } from '../../lib/health-score';

// ── Immutability ───────────────────────────────────────────────────────────

describe('immutability', () => {
    test('applyTokenBatch does not mutate input state', () => {
        const state = { ...INITIAL_STATE };
        const frozen = JSON.stringify(state);
        applyTokenBatch(state, { inputTokens: 100, outputTokens: 50, model: 'claude-sonnet-4-6' });
        expect(JSON.stringify(state)).toBe(frozen);
    });

    test('applyStreamComplete does not mutate input state', () => {
        const state = { ...INITIAL_STATE };
        const frozen = JSON.stringify(state);
        applyStreamComplete(state, { inputTokens: 100, outputTokens: 50, model: 'claude-sonnet-4-6' });
        expect(JSON.stringify(state)).toBe(frozen);
    });

    test('applyHealthBroken does not mutate input state', () => {
        const state = { ...INITIAL_STATE };
        const frozen = JSON.stringify(state);
        applyHealthBroken(state, 'test error');
        expect(JSON.stringify(state)).toBe(frozen);
    });
});

// ── applyTokenBatch ────────────────────────────────────────────────────────

describe('applyTokenBatch', () => {
    test('sets streaming to true', () => {
        const next = applyTokenBatch(INITIAL_STATE, { inputTokens: 100, outputTokens: 50, model: 'claude-sonnet-4-6' });
        expect(next.streaming).toBe(true);
    });

    test('clears healthBroken', () => {
        const state: OverlayState = { ...INITIAL_STATE, healthBroken: 'some error' };
        const next = applyTokenBatch(state, { inputTokens: 100, outputTokens: 50, model: 'claude-sonnet-4-6' });
        expect(next.healthBroken).toBeNull();
    });

    test('sets lastRequest with cost', () => {
        const next = applyTokenBatch(INITIAL_STATE, { inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet-4-6' });
        expect(next.lastRequest).not.toBeNull();
        expect(next.lastRequest!.cost).not.toBeNull();
        expect(next.lastRequest!.cost!).toBeGreaterThan(0);
    });

    test('sets null cost for unknown model', () => {
        const next = applyTokenBatch(INITIAL_STATE, { inputTokens: 1000, outputTokens: 500, model: 'unknown' });
        expect(next.lastRequest!.cost).toBeNull();
    });
});

// ── applyStreamComplete ────────────────────────────────────────────────────

describe('applyStreamComplete', () => {
    test('sets streaming to false', () => {
        const streaming: OverlayState = { ...INITIAL_STATE, streaming: true };
        const next = applyStreamComplete(streaming, { inputTokens: 100, outputTokens: 50, model: 'claude-sonnet-4-6' });
        expect(next.streaming).toBe(false);
    });
});

// ── applyHealthBroken / applyHealthRecovered ───────────────────────────────

describe('health state', () => {
    test('applyHealthBroken sets message', () => {
        const next = applyHealthBroken(INITIAL_STATE, 'sentinel missing');
        expect(next.healthBroken).toBe('sentinel missing');
    });

    test('applyHealthRecovered clears message', () => {
        const broken: OverlayState = { ...INITIAL_STATE, healthBroken: 'error' };
        const next = applyHealthRecovered(broken);
        expect(next.healthBroken).toBeNull();
    });
});

// ── applyMessageLimit ──────────────────────────────────────────────────────

describe('applyMessageLimit', () => {
    test('stores utilization value', () => {
        const next = applyMessageLimit(INITIAL_STATE, 0.73);
        expect(next.messageLimitUtilization).toBe(0.73);
    });
});

// ── applyRestoredConversation ──────────────────────────────────────────────

describe('applyRestoredConversation', () => {
    const record: ConversationRecord = {
        id: 'conv-1',
        startedAt: Date.now() - 60000,
        lastActiveAt: Date.now(),
        finalized: false,
        turnCount: 5,
        totalInputTokens: 50000,
        totalOutputTokens: 20000,
        peakContextPct: 35,
        lastContextPct: 35,
        model: 'claude-haiku-4-5',
        estimatedCost: 0.25,
        turns: [],
        dna: { subject: '', lastContext: '', hints: [] },
        _v: 1,
    };

    const health: HealthScore = { level: 'healthy', label: 'Healthy', coaching: 'test', contextPct: 35 };

    test('computes contextPct from cumulative tokens', () => {
        const next = applyRestoredConversation(INITIAL_STATE, record, health);
        // (50000 + 20000) / 200000 * 100 = 35%
        expect(next.contextPct).toBeCloseTo(35, 1);
    });

    test('restores session aggregates', () => {
        const next = applyRestoredConversation(INITIAL_STATE, record, health);
        expect(next.session.requestCount).toBe(5);
        expect(next.session.totalInputTokens).toBe(50000);
        expect(next.session.totalOutputTokens).toBe(20000);
        expect(next.session.totalCost).toBe(0.25);
    });

    test('sets health', () => {
        const next = applyRestoredConversation(INITIAL_STATE, record, health);
        expect(next.health).toEqual(health);
    });

    test('handles null health', () => {
        const next = applyRestoredConversation(INITIAL_STATE, record, null);
        expect(next.health).toBeNull();
    });
});

// ── Draft estimate ─────────────────────────────────────────────────────────

describe('draft estimate', () => {
    const baseEstimate = {
        estimatedTokens: 100,
        estimatedTokensHigh: 100,
        textTokens: 100,
        estimatedSessionPct: 2.5,
        estimatedSessionPctHigh: 2.5,
        projectedTotalPct: 12.5,
        modelComparisons: [],
        warning: null,
        attachmentBreakdown: [],
        attachmentWarnings: [],
        hasUnknownImage: false,
        hasPdf: false,
        projectedContextPctLow: 0.01,
        projectedContextPctHigh: 0.01,
        contextWindowSize: 1_000_000,
        contextOverrunWarning: null,
    };

    test('applyDraftEstimate sets estimate', () => {
        const next = applyDraftEstimate(INITIAL_STATE, baseEstimate);
        expect(next.draftEstimate).toEqual(baseEstimate);
    });

    test('applyDraftEstimate with null clears estimate', () => {
        const state: OverlayState = {
            ...INITIAL_STATE,
            draftEstimate: { ...baseEstimate, estimatedSessionPct: null, estimatedSessionPctHigh: null, projectedTotalPct: null },
        };
        const next = applyDraftEstimate(state, null);
        expect(next.draftEstimate).toBeNull();
    });

    test('clearDraftEstimate sets draftEstimate to null', () => {
        const state: OverlayState = {
            ...INITIAL_STATE,
            draftEstimate: { ...baseEstimate, estimatedSessionPct: null, estimatedSessionPctHigh: null, projectedTotalPct: null },
        };
        const next = clearDraftEstimate(state);
        expect(next.draftEstimate).toBeNull();
    });
});

// ── INITIAL_STATE is clean ─────────────────────────────────────────────────

describe('INITIAL_STATE', () => {
    test('all fields have correct initial values', () => {
        expect(INITIAL_STATE.lastRequest).toBeNull();
        expect(INITIAL_STATE.session.requestCount).toBe(0);
        expect(INITIAL_STATE.session.totalInputTokens).toBe(0);
        expect(INITIAL_STATE.session.totalOutputTokens).toBe(0);
        expect(INITIAL_STATE.session.totalCost).toBeNull();
        expect(INITIAL_STATE.messageLimitUtilization).toBeNull();
        expect(INITIAL_STATE.contextPct).toBeNull();
        expect(INITIAL_STATE.healthBroken).toBeNull();
        expect(INITIAL_STATE.streaming).toBe(false);
        expect(INITIAL_STATE.health).toBeNull();
        expect(INITIAL_STATE.lastDeltaUtilization).toBeNull();
        expect(INITIAL_STATE.draftEstimate).toBeNull();
    });
});
