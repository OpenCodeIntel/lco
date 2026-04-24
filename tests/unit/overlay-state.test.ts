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
    applyUsageBudget,
} from '../../lib/overlay-state';
import type { OverlayState } from '../../lib/overlay-state';
import type { TabState, UsageBudgetResult } from '../../lib/message-types';

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

    it('preserves contextPct from prior state (per-turn context fill managed by content script)', () => {
        const withContext: OverlayState = { ...INITIAL_STATE, contextPct: 12.5 };
        const next = applyTokenBatch(withContext, TOKEN_PAYLOAD);
        expect(next.contextPct).toBe(12.5);
    });

    it('preserves null contextPct when no prior value exists', () => {
        const next = applyTokenBatch(INITIAL_STATE, TOKEN_PAYLOAD);
        expect(next.contextPct).toBeNull();
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
        const next = applyStorageResponse(INITIAL_STATE, tab);
        expect(next.lastRequest?.inputTokens).toBe(5000);
        expect(next.lastRequest?.outputTokens).toBe(800);
    });

    it('preserves session totals (managed per-conversation by content script)', () => {
        const state: OverlayState = {
            ...INITIAL_STATE,
            session: { requestCount: 15, totalInputTokens: 4000, totalOutputTokens: 2000, totalCost: 0.05 },
        };
        const next = applyStorageResponse(state, makeTabState());
        expect(next.session.requestCount).toBe(15);
        expect(next.session.totalInputTokens).toBe(4000);
        expect(next.session.totalCost).toBe(0.05);
    });

    it('preserves contextPct (managed per-conversation by content script)', () => {
        const state: OverlayState = { ...INITIAL_STATE, contextPct: 2.5 };
        const next = applyStorageResponse(state, makeTabState({ inputTokens: 100000, outputTokens: 0 }));
        expect(next.contextPct).toBe(2.5);
    });

    it('updates messageLimitUtilization from tabState', () => {
        const tab = makeTabState({ messageLimitUtilization: 0.65 });
        const next = applyStorageResponse(INITIAL_STATE, tab);
        expect(next.messageLimitUtilization).toBe(0.65);
    });

    it('preserves existing messageLimitUtilization when tabState has none', () => {
        const state: OverlayState = { ...INITIAL_STATE, messageLimitUtilization: 0.5 };
        const { messageLimitUtilization: _, ...tabWithoutLimit } = makeTabState();
        const next = applyStorageResponse(state, tabWithoutLimit as TabState);
        expect(next.messageLimitUtilization).toBe(0.5);
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

// ── lastDeltaUtilization (LCO-34) ────────────────────────────────────────────

describe('lastDeltaUtilization in INITIAL_STATE', () => {
    it('starts as null', () => {
        expect(INITIAL_STATE.lastDeltaUtilization).toBeNull();
    });
});

describe('lastDeltaUtilization spread semantics', () => {
    it('is preserved through applyTokenBatch', () => {
        const state: OverlayState = { ...INITIAL_STATE, lastDeltaUtilization: 3.7 };
        const next = applyTokenBatch(state, TOKEN_PAYLOAD);
        expect(next.lastDeltaUtilization).toBe(3.7);
    });

    it('is preserved through applyStreamComplete', () => {
        const state: OverlayState = { ...INITIAL_STATE, lastDeltaUtilization: 2.1 };
        const next = applyStreamComplete(state, TOKEN_PAYLOAD);
        expect(next.lastDeltaUtilization).toBe(2.1);
    });

    it('is preserved through applyStorageResponse', () => {
        const state: OverlayState = { ...INITIAL_STATE, lastDeltaUtilization: 5.0 };
        const next = applyStorageResponse(state, makeTabState());
        expect(next.lastDeltaUtilization).toBe(5.0);
    });

    it('can be set via spread on INITIAL_STATE (content script pattern)', () => {
        const state: OverlayState = { ...INITIAL_STATE, lastDeltaUtilization: 4.2 };
        expect(state.lastDeltaUtilization).toBe(4.2);
    });

    it('resets to null when spreading INITIAL_STATE (nav reset pattern)', () => {
        const state: OverlayState = { ...INITIAL_STATE, lastDeltaUtilization: 8.0 };
        const reset: OverlayState = { ...INITIAL_STATE };
        expect(reset.lastDeltaUtilization).toBeNull();
        // The old state is unchanged.
        expect(state.lastDeltaUtilization).toBe(8.0);
    });
});

// ── applyUsageBudget ──────────────────────────────────────────────────────────

function makeBudget(weeklyPct: number, zone: UsageBudgetResult['zone'] = 'comfortable'): UsageBudgetResult {
    return {
        sessionPct: 10,
        weeklyPct,
        sessionMinutesUntilReset: 120,
        weeklyResetLabel: 'Wed 9:00 AM',
        zone,
        statusLabel: `10% used; resets in 2h`,
    };
}

describe('applyUsageBudget', () => {
    it('sets usageBudget on state', () => {
        const budget = makeBudget(71, 'moderate');
        const next = applyUsageBudget(INITIAL_STATE, budget);
        expect(next.usageBudget).toBe(budget);
    });

    it('overwrites a previous usageBudget value', () => {
        const first = makeBudget(30, 'comfortable');
        const second = makeBudget(85, 'tight');
        const state = applyUsageBudget(INITIAL_STATE, first);
        const next = applyUsageBudget(state, second);
        expect(next.usageBudget?.weeklyPct).toBe(85);
    });

    it('does not mutate other fields', () => {
        const budget = makeBudget(50);
        const next = applyUsageBudget(INITIAL_STATE, budget);
        expect(next.streaming).toBe(INITIAL_STATE.streaming);
        expect(next.lastRequest).toBe(INITIAL_STATE.lastRequest);
        expect(next.messageLimitUtilization).toBe(INITIAL_STATE.messageLimitUtilization);
    });

    it('INITIAL_STATE has null usageBudget', () => {
        expect(INITIAL_STATE.usageBudget).toBeNull();
    });

    it('is preserved through applyTokenBatch', () => {
        const budget = makeBudget(71, 'moderate');
        const state: OverlayState = { ...INITIAL_STATE, usageBudget: budget };
        const next = applyTokenBatch(state, TOKEN_PAYLOAD);
        expect(next.usageBudget).toBe(budget);
    });

    it('is preserved through applyStreamComplete', () => {
        const budget = makeBudget(91, 'critical');
        const state: OverlayState = { ...INITIAL_STATE, usageBudget: budget };
        const next = applyStreamComplete(state, TOKEN_PAYLOAD);
        expect(next.usageBudget).toBe(budget);
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
