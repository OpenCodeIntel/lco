// tests/integration/pipeline.test.ts
// Data transformation chain: raw SSE-like data -> parsed event -> token data ->
// bridge message -> overlay state -> cost calculation -> UI-ready data.
//
// Wires real functions from lib/ together. No chrome APIs needed; transport
// boundaries are mocked but data transformations use real code.
//
// Mocked boundaries:
//   - postMessage (Room 1 -> Room 2): simulated as direct function call
//   - chrome.runtime.sendMessage (Room 2 -> Room 3): simulated as direct call
//   The data shapes at each hop are real. Only the transport is skipped.

import { describe, it, expect } from 'vitest';
import { isValidBridgeSchema } from '../../lib/bridge-validation';
import { LCO_NAMESPACE } from '../../lib/message-types';
import type {
    TokenBatchPayload,
    StreamCompletePayload,
    StoreTokenBatchMessage,
    TabState,
    SessionCost,
} from '../../lib/message-types';
import {
    INITIAL_STATE,
    applyTokenBatch,
    applyStreamComplete,
    applyStorageResponse,
    applyMessageLimit,
    applyHealthBroken,
    applyHealthRecovered,
} from '../../lib/overlay-state';
import type { OverlayState } from '../../lib/overlay-state';
import { calculateCost, getContextWindowSize } from '../../lib/pricing';

const SESSION_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── Simulate Room 3 (background) storage handler ────────────────────────────
// Mirrors the background.ts STORE_TOKEN_BATCH handler logic:
// 1. Update tab state
// 2. If stopReason is present, accumulate session cost

function simulateBackgroundStore(
    msg: StoreTokenBatchMessage,
    prevSession: SessionCost,
): { tabState: TabState; sessionCost: SessionCost } {
    const tabState: TabState = {
        platform: msg.platform,
        model: msg.model,
        inputTokens: msg.inputTokens,
        outputTokens: msg.outputTokens,
        stopReason: msg.stopReason,
        updatedAt: Date.now(),
    };

    let sessionCost = { ...prevSession };
    if (msg.stopReason !== null) {
        const cost = calculateCost(msg.inputTokens, msg.outputTokens, msg.model);
        sessionCost = {
            totalInputTokens: prevSession.totalInputTokens + msg.inputTokens,
            totalOutputTokens: prevSession.totalOutputTokens + msg.outputTokens,
            requestCount: prevSession.requestCount + 1,
            estimatedCost: cost !== null
                ? (prevSession.estimatedCost ?? 0) + cost
                : prevSession.estimatedCost,
            updatedAt: Date.now(),
        };
    }

    return { tabState, sessionCost };
}

const EMPTY_SESSION: SessionCost = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    requestCount: 0,
    updatedAt: Date.now(),
};

// ── Full pipeline simulation ────────────────────────────────────────────────
// Simulates: SSE data -> bridge message -> validation -> overlay state ->
// background store -> storage response -> final overlay state

interface PipelineResult {
    bridgeValid: boolean;
    overlayAfterBatch: OverlayState;
    overlayAfterComplete: OverlayState;
    overlayFinal: OverlayState;
    sessionCost: SessionCost;
    contextPct: number;
}

function runPipeline(
    inputTokens: number,
    outputTokensBatch: number,
    outputTokensFinal: number,
    model: string,
    stopReason: string | null,
): PipelineResult {
    // Step 1: Construct TOKEN_BATCH (as inject.ts would during streaming)
    const batch: TokenBatchPayload = {
        namespace: LCO_NAMESPACE,
        type: 'TOKEN_BATCH',
        token: SESSION_TOKEN,
        platform: 'claude',
        inputTokens,
        outputTokens: outputTokensBatch,
        model,
    };

    // Step 2: Validate bridge message (Layer 5)
    const bridgeValid = isValidBridgeSchema(batch);

    // Step 3: Apply to overlay state (content script)
    const overlayAfterBatch = applyTokenBatch(INITIAL_STATE, {
        inputTokens: batch.inputTokens,
        outputTokens: batch.outputTokens,
        model: batch.model,
    });

    // Step 4: Construct STREAM_COMPLETE (final counts)
    const complete: StreamCompletePayload = {
        namespace: LCO_NAMESPACE,
        type: 'STREAM_COMPLETE',
        token: SESSION_TOKEN,
        platform: 'claude',
        inputTokens,
        outputTokens: outputTokensFinal,
        model,
        stopReason,
    };

    // Step 5: Apply STREAM_COMPLETE to overlay
    const overlayAfterComplete = applyStreamComplete(overlayAfterBatch, {
        inputTokens: complete.inputTokens,
        outputTokens: complete.outputTokens,
        model: complete.model,
    });

    // Step 6: Forward to background as STORE_TOKEN_BATCH
    const storeMsg: StoreTokenBatchMessage = {
        type: 'STORE_TOKEN_BATCH',
        platform: complete.platform,
        model: complete.model,
        inputTokens: complete.inputTokens,
        outputTokens: complete.outputTokens,
        stopReason: complete.stopReason,
    };

    // Step 7: Background processes and returns tab state + session cost
    const { tabState, sessionCost } = simulateBackgroundStore(storeMsg, EMPTY_SESSION);

    // Step 8: Content script applies storage response to overlay
    const overlayFinal = applyStorageResponse(overlayAfterComplete, tabState);

    // Step 9: Compute contextPct (content script does this cumulatively)
    const ctxWindow = getContextWindowSize(model);
    const contextPct = ((inputTokens + outputTokensFinal) / ctxWindow) * 100;

    return {
        bridgeValid,
        overlayAfterBatch,
        overlayAfterComplete,
        overlayFinal,
        sessionCost,
        contextPct,
    };
}

// ── Scenario 1: Short response (typical Q&A) ────────────────────────────────

describe('pipeline: short response', () => {
    const result = runPipeline(50, 100, 150, 'claude-sonnet-4-6', 'end_turn');

    it('bridge message validates', () => {
        expect(result.bridgeValid).toBe(true);
    });

    it('overlay shows streaming during TOKEN_BATCH', () => {
        expect(result.overlayAfterBatch.streaming).toBe(true);
    });

    it('overlay shows not streaming after STREAM_COMPLETE', () => {
        expect(result.overlayAfterComplete.streaming).toBe(false);
    });

    it('final overlay has correct token counts from storage', () => {
        expect(result.overlayFinal.lastRequest).not.toBeNull();
        expect(result.overlayFinal.lastRequest!.inputTokens).toBe(50);
        expect(result.overlayFinal.lastRequest!.outputTokens).toBe(150);
    });

    it('cost is calculated correctly', () => {
        // 50 * 0.000003 + 150 * 0.000015 = 0.00015 + 0.00225 = 0.0024
        expect(result.overlayFinal.lastRequest!.cost).toBeCloseTo(0.0024, 10);
    });

    it('session cost accumulates on STREAM_COMPLETE', () => {
        expect(result.sessionCost.requestCount).toBe(1);
        expect(result.sessionCost.totalInputTokens).toBe(50);
        expect(result.sessionCost.totalOutputTokens).toBe(150);
        expect(result.sessionCost.estimatedCost).toBeCloseTo(0.0024, 10);
    });

    it('contextPct is computed from total tokens', () => {
        // (50 + 150) / 200000 * 100 = 0.1%
        expect(result.contextPct).toBeCloseTo(0.1, 4);
    });
});

// ── Scenario 2: Long response (code generation) ─────────────────────────────

describe('pipeline: long response', () => {
    const result = runPipeline(2000, 5000, 8000, 'claude-opus-4-6', 'end_turn');

    it('bridge validates', () => {
        expect(result.bridgeValid).toBe(true);
    });

    it('final token counts reflect STREAM_COMPLETE (not batch)', () => {
        expect(result.overlayFinal.lastRequest!.outputTokens).toBe(8000);
    });

    it('cost uses Opus pricing', () => {
        // 2000 * 0.000005 + 8000 * 0.000025 = 0.01 + 0.2 = 0.21
        expect(result.overlayFinal.lastRequest!.cost).toBeCloseTo(0.21, 10);
    });

    it('contextPct reflects large token usage', () => {
        // (2000 + 8000) / 200000 * 100 = 5%
        expect(result.contextPct).toBeCloseTo(5.0, 4);
    });
});

// ── Scenario 3: Unknown model ───────────────────────────────────────────────

describe('pipeline: unknown model', () => {
    const result = runPipeline(100, 200, 300, 'claude-future-v99', 'end_turn');

    it('bridge validates (model is any string)', () => {
        expect(result.bridgeValid).toBe(true);
    });

    it('cost is null for unknown model', () => {
        expect(result.overlayFinal.lastRequest!.cost).toBeNull();
    });

    it('session cost estimatedCost remains undefined for unknown model', () => {
        // When all requests use unknown models, estimatedCost never gets set
        expect(result.sessionCost.estimatedCost).toBeUndefined();
    });

    it('contextPct still computes using default 200k window', () => {
        // (100 + 300) / 200000 * 100 = 0.2%
        expect(result.contextPct).toBeCloseTo(0.2, 4);
    });
});

// ── Scenario 4: Empty response (error/cancelled) ───────────────────────────

describe('pipeline: empty/error response', () => {
    const result = runPipeline(100, 0, 0, 'claude-sonnet-4-6', null);

    it('bridge validates with zero output tokens', () => {
        expect(result.bridgeValid).toBe(true);
    });

    it('session does not accumulate when stopReason is null', () => {
        expect(result.sessionCost.requestCount).toBe(0);
        expect(result.sessionCost.totalInputTokens).toBe(0);
    });
});

// ── Scenario 5: Haiku (cheapest model) ──────────────────────────────────────

describe('pipeline: Haiku model', () => {
    const result = runPipeline(500, 800, 1200, 'claude-haiku-4-5', 'end_turn');

    it('cost uses Haiku pricing', () => {
        // 500 * 0.000001 + 1200 * 0.000005 = 0.0005 + 0.006 = 0.0065
        expect(result.overlayFinal.lastRequest!.cost).toBeCloseTo(0.0065, 10);
    });
});

// ── Health state transitions ────────────────────────────────────────────────

describe('pipeline: health state transitions', () => {
    it('HEALTH_BROKEN sets healthBroken string', () => {
        const state = applyHealthBroken(INITIAL_STATE, 'stream_start never arrived');
        expect(state.healthBroken).toBe('stream_start never arrived');
    });

    it('TOKEN_BATCH clears healthBroken', () => {
        const broken = applyHealthBroken(INITIAL_STATE, 'error');
        const cleared = applyTokenBatch(broken, {
            inputTokens: 10,
            outputTokens: 20,
            model: 'claude-sonnet-4-6',
        });
        expect(cleared.healthBroken).toBeNull();
    });

    it('HEALTH_RECOVERED clears healthBroken', () => {
        const broken = applyHealthBroken(INITIAL_STATE, 'error');
        const recovered = applyHealthRecovered(broken);
        expect(recovered.healthBroken).toBeNull();
    });

    it('MESSAGE_LIMIT_UPDATE stores utilization', () => {
        const state = applyMessageLimit(INITIAL_STATE, 0.72);
        expect(state.messageLimitUtilization).toBe(0.72);
    });

    it('storage response preserves messageLimitUtilization from tab state', () => {
        const state = applyStorageResponse(INITIAL_STATE, {
            platform: 'claude',
            model: 'claude-sonnet-4-6',
            inputTokens: 100,
            outputTokens: 200,
            stopReason: 'end_turn',
            messageLimitUtilization: 0.55,
            updatedAt: Date.now(),
        });
        expect(state.messageLimitUtilization).toBe(0.55);
    });
});
