// lib/overlay-state.ts
// Pure state transitions for the overlay. No DOM refs, no chrome APIs.
// Each function takes the current state and a payload, returns a new state object.
// The content script calls these and passes the result to overlay.render().

import { calculateCost, getContextWindowSize } from './pricing';
import type { TabState, UsageBudgetSession, UsageBudgetCredit } from './message-types';
import type { HealthScore } from './health-score';
import type { ConversationRecord } from './conversation-store';
import type { PreSubmitEstimate } from './pre-submit';
import type { WeeklyEta } from './weekly-cap-eta';

/**
 * Renderable budget variants only. The unsupported variant has nothing for
 * the in-page overlay to draw, so it never reaches state: the content
 * script gates the call before applyUsageBudget runs.
 */
export type RenderableBudget = UsageBudgetSession | UsageBudgetCredit;

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
    /**
     * Pre-submit cost estimate for the current draft in the compose box.
     * Null when no draft is being composed or draft is below threshold.
     * Set by the compose box observer or the pre-send fallback in inject.ts.
     */
    draftEstimate: PreSubmitEstimate | null;
    /**
     * Tier-aware usage budget derived from /api/organizations/{orgId}/usage.
     * Null until the first successful fetchAndStoreUsageLimits call, or when
     * the extension is running outside of claude.ai (no usage endpoint available).
     * Only renderable variants land here; the unsupported variant is filtered
     * out at the call site (the overlay has no empty-state UI for it).
     */
    usageBudget: RenderableBudget | null;
    /**
     * Projected time-to-100% for the weekly usage cap.
     * Null until enough snapshots have accumulated (MIN_SNAPSHOTS_FOR_ETA),
     * when usage is flat or declining, or immediately after a weekly reset.
     * Session tier only: credit (Enterprise) has no weekly rolling window.
     */
    weeklyEta: WeeklyEta | null;
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
    draftEstimate: null,
    usageBudget: null,
    weeklyEta: null,
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

/** Set the pre-submit draft estimate. Called by the compose box observer or pre-send fallback. */
export function applyDraftEstimate(state: OverlayState, estimate: PreSubmitEstimate | null): OverlayState {
    return { ...state, draftEstimate: estimate };
}

/** Clear the draft estimate. Called on TOKEN_BATCH (message sent) and SPA navigation. */
export function clearDraftEstimate(state: OverlayState): OverlayState {
    return { ...state, draftEstimate: null };
}

/**
 * Apply a fresh renderable budget. Called after every fetchAndStoreUsageLimits
 * call. Typed to reject the unsupported variant: the overlay has no UI for an
 * unrecognized account type, and forcing the caller to gate first keeps the
 * bar-rendering code total.
 */
export function applyUsageBudget(state: OverlayState, budget: RenderableBudget): OverlayState {
    return { ...state, usageBudget: budget };
}

/**
 * Apply or clear the weekly-cap ETA projection.
 * Called alongside applyUsageBudget after each usage fetch.
 * Null clears the ETA row (flat/declining usage, not enough history, post-reset).
 */
export function applyWeeklyEta(state: OverlayState, eta: WeeklyEta | null): OverlayState {
    return { ...state, weeklyEta: eta };
}
