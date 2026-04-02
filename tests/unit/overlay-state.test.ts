// tests/unit/overlay-state.test.ts
// Tests for pure state transition functions in lib/overlay-state.ts.

import { describe, it, expect } from 'vitest';
import {
    INITIAL_STATE,
    applyTokenBatch,
    applyStreamComplete,
    applyStorageResponse,
    applyHealthBroken,
    applyHealthRecovered,
    applyMessageLimit,
} from '../../lib/overlay-state';
import type { OverlayState } from '../../lib/overlay-state';
import type { TabState, SessionCost } from '../../lib/message-types';

const MODEL = 'claude-haiku-4-5';
const TOKEN_PAYLOAD = { inputTokens: 1000, outputTokens: 200, model: MODEL };

function makeTabState(overrides: Partial<TabState> = {}): TabState {
    return {
        platform: 'claude.ai',
        inputTokens: 1000,
        outputTokens: 200,
        model: MODEL,
        stopReason: null,
        updatedAt: Date.now(),
        ...overrides,
    };
}

function makeSessionCost(overrides: Partial<SessionCost> = {}): SessionCost {
    return {
        requestCount: 1,
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        estimatedCost: 0.002,
        updatedAt: Date.now(),
        ...overrides,
    };
}

// ── INITIAL_STATE ─────────────────────────────────────────────────────────────

describe('INITIAL_STATE', () => {
    it('has null lastRequest', () => {
        expect(INITIAL_STATE.lastRequest).toBeNull();
    });

    it('has zero session counts', () => {
        expect(INITIAL_STATE.session.requestCount).toBe(0);
        expect(INITIAL_STATE.session.totalCost).toBeNull();
    });

    it('has null contextPct', () => {
        expect(INITIAL_STATE.contextPct).toBeNull();
    });

    it('is not streaming', () => {
        expect(INITIAL_STATE.streaming).toBe(false);
    });
});

// ── applyTokenBatch ───────────────────────────────────────────────────────────

describe('applyTokenBatch', () => {
    it('sets lastRequest from payload', () => {
        const next = applyTokenBatch(INITIAL_STATE, TOKEN_PAYLOAD);
        expect(next.lastRequest?.inputTokens).toBe(1000);
        expect(next.lastRequest?.outputTokens).toBe(200);
        expect(next.lastRequest?.model).toBe(MODEL);
    });

    it('sets streaming to true', () => {
        const next = applyTokenBatch(INITIAL_STATE, TOKEN_PAYLOAD);
        expect(next.streaming).toBe(true);
    });

    it('clears healthBroken', () => {
        const broken: OverlayState = { ...INITIAL_STATE, healthBroken: 'fetch failed' };
        const next = applyTokenBatch(broken, TOKEN_PAYLOAD);
        expect(next.healthBroken).toBeNull();
    });

    it('computes contextPct for known model', () => {
        const next = applyTokenBatch(INITIAL_STATE, TOKEN_PAYLOAD);
        // 1200 tokens / 200000 context window * 100 = 0.6%
        expect(next.contextPct).toBeCloseTo(0.6, 1);
    });

    it('uses DEFAULT_CONTEXT_WINDOW for unknown models instead of falling back', () => {
        // Unknown models fall back to 200k context window, so contextPct is still computed.
        const next = applyTokenBatch(INITIAL_STATE, { ...TOKEN_PAYLOAD, model: 'unknown-model-xyz' });
        // 1200 tokens / 200000 default window * 100 = 0.6%
        expect(next.contextPct).toBeCloseTo(0.6, 1);
    });

    it('does not mutate the original state', () => {
        const original = { ...INITIAL_STATE };
        applyTokenBatch(INITIAL_STATE, TOKEN_PAYLOAD);
        expect(INITIAL_STATE.streaming).toBe(original.streaming);
        expect(INITIAL_STATE.lastRequest).toBe(original.lastRequest);
    });

    it('preserves session from prior state', () => {
        const state: OverlayState = {
            ...INITIAL_STATE,
            session: { requestCount: 3, totalInputTokens: 5000, totalOutputTokens: 1000, totalCost: 0.05 },
        };
        const next = applyTokenBatch(state, TOKEN_PAYLOAD);
        expect(next.session.requestCount).toBe(3);
    });
});

// ── applyStreamComplete ───────────────────────────────────────────────────────

describe('applyStreamComplete', () => {
    it('sets streaming to false', () => {
        const streaming: OverlayState = { ...INITIAL_STATE, streaming: true };
        const next = applyStreamComplete(streaming, TOKEN_PAYLOAD);
        expect(next.streaming).toBe(false);
    });

    it('updates lastRequest with final token counts', () => {
        const next = applyStreamComplete(INITIAL_STATE, { inputTokens: 999, outputTokens: 111, model: MODEL });
        expect(next.lastRequest?.inputTokens).toBe(999);
        expect(next.lastRequest?.outputTokens).toBe(111);
    });

    it('calculates cost for the final token counts', () => {
        const next = applyStreamComplete(INITIAL_STATE, TOKEN_PAYLOAD);
        expect(typeof next.lastRequest?.cost).toBe('number');
    });

    it('does not clear healthBroken (only TOKEN_BATCH does)', () => {
        const broken: OverlayState = { ...INITIAL_STATE, healthBroken: 'broken' };
        const next = applyStreamComplete(broken, TOKEN_PAYLOAD);
        expect(next.healthBroken).toBe('broken');
    });
});

// ── applyStorageResponse ──────────────────────────────────────────────────────

describe('applyStorageResponse', () => {
    it('updates lastRequest from tabState', () => {
        const tab = makeTabState({ inputTokens: 5000, outputTokens: 800 });
        const session = makeSessionCost();
        const next = applyStorageResponse(INITIAL_STATE, tab, session);
        expect(next.lastRequest?.inputTokens).toBe(5000);
        expect(next.lastRequest?.outputTokens).toBe(800);
    });

    it('updates session totals from sessionCost', () => {
        const tab = makeTabState();
        const session = makeSessionCost({ requestCount: 7, totalInputTokens: 14000, estimatedCost: 0.1 });
        const next = applyStorageResponse(INITIAL_STATE, tab, session);
        expect(next.session.requestCount).toBe(7);
        expect(next.session.totalInputTokens).toBe(14000);
        expect(next.session.totalCost).toBe(0.1);
    });

    it('maps absent estimatedCost to null totalCost', () => {
        const tab = makeTabState();
        const { estimatedCost: _, ...sessionWithoutCost } = makeSessionCost();
        const next = applyStorageResponse(INITIAL_STATE, tab, sessionWithoutCost as SessionCost);
        expect(next.session.totalCost).toBeNull();
    });

    it('updates messageLimitUtilization from tabState', () => {
        const tab = makeTabState({ messageLimitUtilization: 0.65 });
        const next = applyStorageResponse(INITIAL_STATE, tab, makeSessionCost());
        expect(next.messageLimitUtilization).toBe(0.65);
    });

    it('preserves existing messageLimitUtilization when tabState has none', () => {
        const state: OverlayState = { ...INITIAL_STATE, messageLimitUtilization: 0.5 };
        const { messageLimitUtilization: _, ...tabWithoutLimit } = makeTabState();
        const next = applyStorageResponse(state, tabWithoutLimit as TabState, makeSessionCost());
        expect(next.messageLimitUtilization).toBe(0.5);
    });

    it('computes contextPct from tabState token counts', () => {
        const tab = makeTabState({ inputTokens: 100000, outputTokens: 0 });
        const next = applyStorageResponse(INITIAL_STATE, tab, makeSessionCost());
        // 100000 / 200000 * 100 = 50%
        expect(next.contextPct).toBeCloseTo(50, 0);
    });
});

// ── applyHealthBroken ─────────────────────────────────────────────────────────

describe('applyHealthBroken', () => {
    it('sets healthBroken to the given message', () => {
        const next = applyHealthBroken(INITIAL_STATE, 'stream interceptor lost');
        expect(next.healthBroken).toBe('stream interceptor lost');
    });

    it('does not mutate other state fields', () => {
        const next = applyHealthBroken(INITIAL_STATE, 'error');
        expect(next.streaming).toBe(INITIAL_STATE.streaming);
        expect(next.lastRequest).toBe(INITIAL_STATE.lastRequest);
    });

    it('overwrites a previous health message', () => {
        const broken = applyHealthBroken(INITIAL_STATE, 'first error');
        const next = applyHealthBroken(broken, 'second error');
        expect(next.healthBroken).toBe('second error');
    });
});

// ── applyHealthRecovered ──────────────────────────────────────────────────────

describe('applyHealthRecovered', () => {
    it('clears healthBroken to null', () => {
        const broken: OverlayState = { ...INITIAL_STATE, healthBroken: 'stream lost' };
        const next = applyHealthRecovered(broken);
        expect(next.healthBroken).toBeNull();
    });

    it('is a no-op when health is already null', () => {
        const next = applyHealthRecovered(INITIAL_STATE);
        expect(next.healthBroken).toBeNull();
    });
});

// ── applyMessageLimit ─────────────────────────────────────────────────────────

describe('applyMessageLimit', () => {
    it('sets messageLimitUtilization', () => {
        const next = applyMessageLimit(INITIAL_STATE, 0.83);
        expect(next.messageLimitUtilization).toBe(0.83);
    });

    it('accepts 0 and 1 as boundary values', () => {
        expect(applyMessageLimit(INITIAL_STATE, 0).messageLimitUtilization).toBe(0);
        expect(applyMessageLimit(INITIAL_STATE, 1).messageLimitUtilization).toBe(1);
    });

    it('overwrites a previous utilization value', () => {
        const state: OverlayState = { ...INITIAL_STATE, messageLimitUtilization: 0.5 };
        const next = applyMessageLimit(state, 0.9);
        expect(next.messageLimitUtilization).toBe(0.9);
    });
});

// ── state immutability (cross-function) ───────────────────────────────────────

describe('immutability', () => {
    it('each transition returns a new object', () => {
        const s1 = applyTokenBatch(INITIAL_STATE, TOKEN_PAYLOAD);
        const s2 = applyStreamComplete(s1, TOKEN_PAYLOAD);
        const s3 = applyHealthBroken(s2, 'err');
        const s4 = applyHealthRecovered(s3);
        expect(s1).not.toBe(INITIAL_STATE);
        expect(s2).not.toBe(s1);
        expect(s3).not.toBe(s2);
        expect(s4).not.toBe(s3);
    });
});
