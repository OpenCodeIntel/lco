// tests/integration/session-state.test.ts
// State accumulation tests: simulate 10 messages flowing through the pipeline
// sequentially. Verify session totals, contextPct growth, and corrections.
//
// Mocked boundaries:
//   - chrome.storage.session: simulated with in-memory accumulators
//   - chrome.runtime.sendMessage: simulated as direct function call
//   Data transformations use real lib/ functions.

import { describe, it, expect, beforeAll } from 'vitest';
import {
    INITIAL_STATE,
    applyTokenBatch,
    applyStreamComplete,
    applyStorageResponse,
} from '../../lib/overlay-state';
import type { OverlayState } from '../../lib/overlay-state';
import type { TabState, SessionCost } from '../../lib/message-types';
import { calculateCost, getContextWindowSize } from '../../lib/pricing';
import { computeHealthScore, computeGrowthRate } from '../../lib/health-score';
import type { ConversationState } from '../../lib/context-intelligence';

// ── Types ────────────────────────────────────────────────────────────────────

interface MessageSpec {
    inputTokens: number;
    outputTokens: number;
    model: string;
}

interface SessionAccumulator {
    overlayState: OverlayState;
    sessionCost: SessionCost;
    cumulativeInput: number;
    cumulativeOutput: number;
    cumulativeCost: number;
    contextHistory: number[];
    turnCount: number;
}

// ── Session simulation ──────────────────────────────────────────────────────
// Mirrors the content script orchestrator logic for each STREAM_COMPLETE:
// 1. Apply overlay state transitions
// 2. Forward to background (simulate storage update)
// 3. Apply storage response
// 4. Update cumulative conversation state

function initSession(): SessionAccumulator {
    return {
        overlayState: { ...INITIAL_STATE },
        sessionCost: {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            requestCount: 0,
            updatedAt: Date.now(),
        },
        cumulativeInput: 0,
        cumulativeOutput: 0,
        cumulativeCost: 0,
        contextHistory: [],
        turnCount: 0,
    };
}

function processMessage(session: SessionAccumulator, msg: MessageSpec): SessionAccumulator {
    // Step 1: TOKEN_BATCH (live streaming update)
    let overlayState = applyTokenBatch(session.overlayState, msg);

    // Step 2: STREAM_COMPLETE (stream ends)
    overlayState = applyStreamComplete(overlayState, msg);

    // Step 3: Simulate background storage (STORE_TOKEN_BATCH with stopReason)
    const cost = calculateCost(msg.inputTokens, msg.outputTokens, msg.model);
    const cumulativeInput = session.cumulativeInput + msg.inputTokens;
    const cumulativeOutput = session.cumulativeOutput + msg.outputTokens;
    const cumulativeCost = session.cumulativeCost + (cost ?? 0);
    const turnCount = session.turnCount + 1;

    const sessionCost: SessionCost = {
        totalInputTokens: cumulativeInput,
        totalOutputTokens: cumulativeOutput,
        requestCount: turnCount,
        estimatedCost: cost !== null
            ? (session.sessionCost.estimatedCost ?? 0) + cost
            : session.sessionCost.estimatedCost,
        updatedAt: Date.now(),
    };

    // Step 4: Background returns tab state
    const tabState: TabState = {
        platform: 'claude',
        model: msg.model,
        inputTokens: msg.inputTokens,
        outputTokens: msg.outputTokens,
        stopReason: 'end_turn',
        updatedAt: Date.now(),
    };

    // Step 5: Apply storage response
    overlayState = applyStorageResponse(overlayState, tabState);

    // Step 6: Compute cumulative contextPct
    const ctxWindow = getContextWindowSize(msg.model);
    const contextPct = ((cumulativeInput + cumulativeOutput) / ctxWindow) * 100;
    const contextHistory = [...session.contextHistory, contextPct];

    // Step 7: Update overlay with cumulative data
    const health = computeHealthScore({
        contextPct,
        turnCount,
        growthRate: computeGrowthRate(contextHistory),
        model: msg.model,
        isDetailHeavy: false,
    });

    overlayState = {
        ...overlayState,
        contextPct,
        session: {
            requestCount: turnCount,
            totalInputTokens: cumulativeInput,
            totalOutputTokens: cumulativeOutput,
            totalCost: cumulativeCost,
        },
        health,
    };

    return {
        overlayState,
        sessionCost,
        cumulativeInput,
        cumulativeOutput,
        cumulativeCost,
        contextHistory,
        turnCount,
    };
}

// ── Test data: 10 messages with varying sizes ───────────────────────────────

const MESSAGES: MessageSpec[] = [
    { inputTokens: 100, outputTokens: 300,  model: 'claude-sonnet-4-6' },
    { inputTokens: 200, outputTokens: 500,  model: 'claude-sonnet-4-6' },
    { inputTokens: 50,  outputTokens: 150,  model: 'claude-sonnet-4-6' },
    { inputTokens: 800, outputTokens: 2000, model: 'claude-sonnet-4-6' },
    { inputTokens: 30,  outputTokens: 80,   model: 'claude-sonnet-4-6' },
    { inputTokens: 150, outputTokens: 400,  model: 'claude-sonnet-4-6' },
    { inputTokens: 500, outputTokens: 1500, model: 'claude-sonnet-4-6' },
    { inputTokens: 75,  outputTokens: 200,  model: 'claude-sonnet-4-6' },
    { inputTokens: 300, outputTokens: 900,  model: 'claude-sonnet-4-6' },
    { inputTokens: 120, outputTokens: 350,  model: 'claude-sonnet-4-6' },
];

// ── 10-message accumulation ─────────────────────────────────────────────────

describe('session state: 10-message accumulation', () => {
    let finalSession: SessionAccumulator;
    const sessions: SessionAccumulator[] = [];

    const expectedInput = MESSAGES.reduce((sum, m) => sum + m.inputTokens, 0);
    const expectedOutput = MESSAGES.reduce((sum, m) => sum + m.outputTokens, 0);

    beforeAll(() => {
        let session = initSession();
        for (const msg of MESSAGES) {
            session = processMessage(session, msg);
            sessions.push(session);
        }
        finalSession = session;
    });

    it('cumulative input tokens equal sum of all messages', () => {
        expect(finalSession.cumulativeInput).toBe(expectedInput);
        expect(finalSession.overlayState.session.totalInputTokens).toBe(expectedInput);
    });

    it('cumulative output tokens equal sum of all messages', () => {
        expect(finalSession.cumulativeOutput).toBe(expectedOutput);
        expect(finalSession.overlayState.session.totalOutputTokens).toBe(expectedOutput);
    });

    it('request count equals 10', () => {
        expect(finalSession.turnCount).toBe(10);
        expect(finalSession.overlayState.session.requestCount).toBe(10);
    });

    it('session cost equals sum of individual message costs', () => {
        let expectedCost = 0;
        for (const msg of MESSAGES) {
            const cost = calculateCost(msg.inputTokens, msg.outputTokens, msg.model);
            expectedCost += cost ?? 0;
        }
        expect(finalSession.cumulativeCost).toBeCloseTo(expectedCost, 10);
        expect(finalSession.overlayState.session.totalCost).toBeCloseTo(expectedCost, 10);
    });

    it('contextPct grows monotonically', () => {
        for (let i = 1; i < sessions.length; i++) {
            const prev = sessions[i - 1].overlayState.contextPct!;
            const curr = sessions[i].overlayState.contextPct!;
            expect(curr).toBeGreaterThan(prev);
        }
    });

    it('contextPct equals (totalInput + totalOutput) / contextWindow * 100', () => {
        const ctxWindow = getContextWindowSize('claude-sonnet-4-6');
        const expectedPct = ((expectedInput + expectedOutput) / ctxWindow) * 100;
        expect(finalSession.overlayState.contextPct).toBeCloseTo(expectedPct, 6);
    });

    it('context history has 10 entries', () => {
        expect(finalSession.contextHistory).toHaveLength(10);
    });

    it('health score is computed after every message', () => {
        for (const s of sessions) {
            expect(s.overlayState.health).not.toBeNull();
        }
    });

    it('final state is not streaming', () => {
        expect(finalSession.overlayState.streaming).toBe(false);
    });
});

// ── Correction: final counts replace streaming estimates ────────────────────

describe('session state: streaming correction', () => {
    it('storage response corrects lastRequest tokens from BPE count', () => {
        let session = initSession();

        // Step 1: TOKEN_BATCH with approximate streaming count
        let state = applyTokenBatch(session.overlayState, {
            inputTokens: 100,
            outputTokens: 250, // chars/4 estimate during stream
            model: 'claude-sonnet-4-6',
        });

        expect(state.lastRequest!.outputTokens).toBe(250);

        // Step 2: STREAM_COMPLETE with slightly different count
        state = applyStreamComplete(state, {
            inputTokens: 100,
            outputTokens: 280, // final count from inject.ts
            model: 'claude-sonnet-4-6',
        });

        expect(state.lastRequest!.outputTokens).toBe(280);

        // Step 3: Background returns BPE-accurate count
        const tabState: TabState = {
            platform: 'claude',
            model: 'claude-sonnet-4-6',
            inputTokens: 98,   // BPE count differs from chars/4
            outputTokens: 275, // BPE count differs from chars/4
            stopReason: 'end_turn',
            updatedAt: Date.now(),
        };

        state = applyStorageResponse(state, tabState);

        // Storage response overwrites with BPE-accurate counts
        expect(state.lastRequest!.inputTokens).toBe(98);
        expect(state.lastRequest!.outputTokens).toBe(275);
    });

    it('corrected cost recalculates from BPE tokens', () => {
        const state = applyStorageResponse(
            applyStreamComplete(INITIAL_STATE, {
                inputTokens: 100,
                outputTokens: 300,
                model: 'claude-sonnet-4-6',
            }),
            {
                platform: 'claude',
                model: 'claude-sonnet-4-6',
                inputTokens: 95,
                outputTokens: 290,
                stopReason: 'end_turn',
                updatedAt: Date.now(),
            },
        );

        // Cost should use the BPE-corrected values
        const expectedCost = calculateCost(95, 290, 'claude-sonnet-4-6');
        expect(state.lastRequest!.cost).toBe(expectedCost);
    });
});

// ── Mixed models ────────────────────────────────────────────────────────────

describe('session state: mixed models', () => {
    it('session cost accumulates correctly across different models', () => {
        const msgs: MessageSpec[] = [
            { inputTokens: 100, outputTokens: 300, model: 'claude-sonnet-4-6' },
            { inputTokens: 100, outputTokens: 300, model: 'claude-opus-4-6' },
            { inputTokens: 100, outputTokens: 300, model: 'claude-haiku-4-5' },
        ];

        let session = initSession();
        for (const msg of msgs) {
            session = processMessage(session, msg);
        }

        const sonnetCost = calculateCost(100, 300, 'claude-sonnet-4-6')!;
        const opusCost = calculateCost(100, 300, 'claude-opus-4-6')!;
        const haikuCost = calculateCost(100, 300, 'claude-haiku-4-5')!;

        expect(session.cumulativeCost).toBeCloseTo(sonnetCost + opusCost + haikuCost, 10);
    });

    it('unknown model in sequence: session cost accumulates known costs only', () => {
        const msgs: MessageSpec[] = [
            { inputTokens: 100, outputTokens: 300, model: 'claude-sonnet-4-6' },
            { inputTokens: 100, outputTokens: 300, model: 'unknown-model-v9' },
            { inputTokens: 100, outputTokens: 300, model: 'claude-sonnet-4-6' },
        ];

        let session = initSession();
        for (const msg of msgs) {
            session = processMessage(session, msg);
        }

        // Only two Sonnet messages contribute to cost
        const sonnetCost = calculateCost(100, 300, 'claude-sonnet-4-6')!;
        expect(session.cumulativeCost).toBeCloseTo(sonnetCost * 2, 10);
        expect(session.turnCount).toBe(3);
    });
});

// ── Edge case: session with zero-output messages ────────────────────────────

describe('session state: zero-output messages', () => {
    it('zero output tokens do not break accumulation', () => {
        const msgs: MessageSpec[] = [
            { inputTokens: 100, outputTokens: 0, model: 'claude-sonnet-4-6' },
            { inputTokens: 200, outputTokens: 500, model: 'claude-sonnet-4-6' },
        ];

        let session = initSession();
        for (const msg of msgs) {
            session = processMessage(session, msg);
        }

        expect(session.cumulativeInput).toBe(300);
        expect(session.cumulativeOutput).toBe(500);
        expect(session.turnCount).toBe(2);
    });
});
