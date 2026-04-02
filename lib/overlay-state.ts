// lib/overlay-state.ts
// Pure state transitions for the overlay. No DOM refs, no chrome APIs.
// Each function takes the current state and a payload, returns a new state object.
// The content script calls these and passes the result to overlay.render().

import { calculateCost, getContextWindowSize } from './pricing';
import type { TabState, SessionCost } from './message-types';

export interface OverlayState {
    lastRequest: {
        inputTokens: number;
        outputTokens: number;
        model: string;
        cost: number | null;
    } | null;
    session: {
        requestCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCost: number | null;
    };
    messageLimitUtilization: number | null;
    contextPct: number | null;
    healthBroken: string | null;
    streaming: boolean;
}

export const INITIAL_STATE: Readonly<OverlayState> = {
    lastRequest: null,
    session: { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: null },
    messageLimitUtilization: null,
    contextPct: null,
    healthBroken: null,
    streaming: false,
};

function computeContextPct(
    inputTokens: number,
    outputTokens: number,
    model: string,
    fallback: number | null,
): number | null {
    const ctxSize = getContextWindowSize(model);
    if (ctxSize <= 0) return fallback;
    return (inputTokens + outputTokens) / ctxSize * 100;
}

/** Handles TOKEN_BATCH: live update during stream. Clears any prior health warning. */
export function applyTokenBatch(
    state: OverlayState,
    payload: { inputTokens: number; outputTokens: number; model: string },
): OverlayState {
    return {
        ...state,
        lastRequest: {
            inputTokens: payload.inputTokens,
            outputTokens: payload.outputTokens,
            model: payload.model,
            cost: calculateCost(payload.inputTokens, payload.outputTokens, payload.model),
        },
        contextPct: computeContextPct(payload.inputTokens, payload.outputTokens, payload.model, state.contextPct),
        healthBroken: null,
        streaming: true,
    };
}

/** Handles STREAM_COMPLETE: marks streaming done before storage response arrives. */
export function applyStreamComplete(
    state: OverlayState,
    payload: { inputTokens: number; outputTokens: number; model: string },
): OverlayState {
    return {
        ...state,
        lastRequest: {
            inputTokens: payload.inputTokens,
            outputTokens: payload.outputTokens,
            model: payload.model,
            cost: calculateCost(payload.inputTokens, payload.outputTokens, payload.model),
        },
        streaming: false,
    };
}

/** Applied after the background returns accurate BPE counts and session totals. */
export function applyStorageResponse(
    state: OverlayState,
    tabState: TabState,
    sessionCost: SessionCost,
): OverlayState {
    return {
        ...state,
        lastRequest: {
            inputTokens: tabState.inputTokens,
            outputTokens: tabState.outputTokens,
            model: tabState.model,
            cost: calculateCost(tabState.inputTokens, tabState.outputTokens, tabState.model),
        },
        session: {
            requestCount: sessionCost.requestCount,
            totalInputTokens: sessionCost.totalInputTokens,
            totalOutputTokens: sessionCost.totalOutputTokens,
            totalCost: sessionCost.estimatedCost ?? null,
        },
        contextPct: computeContextPct(tabState.inputTokens, tabState.outputTokens, tabState.model, state.contextPct),
        messageLimitUtilization: tabState.messageLimitUtilization ?? state.messageLimitUtilization,
    };
}

/** Handles HEALTH_BROKEN: surface the failure message in the overlay. */
export function applyHealthBroken(state: OverlayState, message: string): OverlayState {
    return { ...state, healthBroken: message };
}

/** Handles HEALTH_RECOVERED: clear the health warning. */
export function applyHealthRecovered(state: OverlayState): OverlayState {
    return { ...state, healthBroken: null };
}

/** Handles MESSAGE_LIMIT_UPDATE: store usage cap utilization. */
export function applyMessageLimit(state: OverlayState, utilization: number): OverlayState {
    return { ...state, messageLimitUtilization: utilization };
}
