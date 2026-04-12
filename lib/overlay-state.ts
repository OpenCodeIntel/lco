// lib/overlay-state.ts
// Pure state transitions for the overlay. No DOM refs, no chrome APIs.
// Each function takes the current state and a payload, returns a new state object.
// The content script calls these and passes the result to overlay.render().

import { calculateCost, getContextWindowSize } from './pricing';
import type { TabState } from './message-types';
import type { HealthScore } from './health-score';
import type { ConversationRecord } from './conversation-store';

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
    /** Conversation health assessment. Null until first STREAM_COMPLETE. */
    health: HealthScore | null;
    /**
     * 5-hour session utilization consumed by the most recent reply, in percentage points.
     * Exact value from Anthropic's usage endpoint (after - before snapshot).
     * Null until the first post-stream usage fetch resolves, or when delta was
     * uncomputable (fetch failure, session reset, first load).
     */
    lastDeltaUtilization: number | null;
}

export const INITIAL_STATE: Readonly<OverlayState> = {
    lastRequest: null,
    session: { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: null },
    messageLimitUtilization: null,
    contextPct: null,
    healthBroken: null,
    streaming: false,
    health: null,
    lastDeltaUtilization: null,
};


/** Handles TOKEN_BATCH: live update during stream. Clears any prior health warning.
 *  Does NOT update contextPct: inject.ts only captures the user's latest message
 *  tokens (not the full conversation context), so per-message contextPct is near-zero.
 *  The content script computes contextPct from cumulative conversation tokens instead. */
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

/** Applied after the background returns accurate BPE counts.
 *  Updates lastRequest with precise token counts from the background worker.
 *  Session and contextPct are managed per-conversation by the content script;
 *  per-tab data from the background would overwrite restored conversation state. */
export function applyStorageResponse(
    state: OverlayState,
    tabState: TabState,
): OverlayState {
    return {
        ...state,
        lastRequest: {
            inputTokens: tabState.inputTokens,
            outputTokens: tabState.outputTokens,
            model: tabState.model,
            cost: calculateCost(tabState.inputTokens, tabState.outputTokens, tabState.model),
        },
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

/**
 * Restore overlay state from a previously stored ConversationRecord.
 * Called on page load and SPA navigation when LCO has existing data.
 * Computes contextPct from cumulative tokens (totalInputTokens + totalOutputTokens)
 * rather than record.lastContextPct, which was stored as near-zero before
 * cumulative tracking was introduced.
 * Does not touch lastRequest or streaming (driven by live SSE only).
 */
export function applyRestoredConversation(
    state: OverlayState,
    record: ConversationRecord,
    health: HealthScore | null,
): OverlayState {
    const ctxWindow = getContextWindowSize(record.model) || 200000;
    const contextPct = ctxWindow > 0
        ? ((record.totalInputTokens + record.totalOutputTokens) / ctxWindow) * 100
        : 0;
    return {
        ...state,
        contextPct,
        session: {
            requestCount: record.turnCount,
            totalInputTokens: record.totalInputTokens,
            totalOutputTokens: record.totalOutputTokens,
            totalCost: record.estimatedCost,
        },
        health,
    };
}
