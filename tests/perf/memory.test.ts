// tests/perf/memory.test.ts
// Memory leak detection: simulates long sessions through the pure agent pipeline.
// Run: bun test tests/perf/memory.test.ts --reporter=verbose

import { describe, test, expect } from 'vitest';
import { calculateCost, getContextWindowSize } from '../../lib/pricing';
import { computeHealthScore, computeGrowthRate } from '../../lib/health-score';
import { analyzeContext, pickTopSignal } from '../../lib/context-intelligence';
import { analyzePrompt } from '../../lib/prompt-analysis';
import { analyzeDelta } from '../../lib/delta-coaching';
import { isValidBridgeSchema } from '../../lib/bridge-validation';
import {
    applyTokenBatch,
    applyStreamComplete,
    applyMessageLimit,
    INITIAL_STATE,
} from '../../lib/overlay-state';
import type { OverlayState } from '../../lib/overlay-state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Forces GC if --expose-gc was passed; otherwise no-op. */
function tryGC(): void {
    if (typeof globalThis.gc === 'function') {
        globalThis.gc();
    }
}

/** Returns current heap in MB. */
function heapMB(): number {
    return process.memoryUsage().heapUsed / (1024 * 1024);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('memory: overlay state accumulation', () => {
    test('no leak over 1000 messages through overlay state', () => {
        tryGC();
        const before = heapMB();

        let state: OverlayState = INITIAL_STATE;
        for (let i = 0; i < 1000; i++) {
            state = applyTokenBatch(state, {
                inputTokens: 1000 + i * 10,
                outputTokens: 300 + i * 5,
                model: 'claude-sonnet-4-6-20250514',
            });
            state = applyStreamComplete(state, {
                inputTokens: 2000 + i * 20,
                outputTokens: 800 + i * 10,
                model: 'claude-sonnet-4-6-20250514',
            });
            if (i % 10 === 0) {
                state = applyMessageLimit(state, (i / 1000) * 100);
            }
        }

        tryGC();
        const after = heapMB();
        const growth = after - before;

        console.log(`Overlay state after 1000 messages: growth=${growth.toFixed(2)}MB`);
        // OverlayState is a fixed-shape object with scalar fields; should stay under 1MB.
        expect(growth).toBeLessThan(1);
    });
});

describe('memory: full agent pipeline', () => {
    test('no leak over 1000 full pipeline cycles', () => {
        tryGC();
        const before = heapMB();

        const contextHistory: number[] = [];
        let state: OverlayState = INITIAL_STATE;

        for (let i = 0; i < 1000; i++) {
            const contextPct = Math.min(99, (i / 1000) * 100);
            contextHistory.push(contextPct);
            // Keep history bounded like the real code would
            if (contextHistory.length > 50) contextHistory.shift();

            // Bridge validation
            isValidBridgeSchema({
                namespace: 'LCO_V1',
                token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                type: 'TOKEN_BATCH',
                inputTokens: 1000 + i,
                outputTokens: 300 + i,
                model: 'claude-sonnet-4-6-20250514',
            });

            // Overlay state
            state = applyTokenBatch(state, {
                inputTokens: 1000 + i,
                outputTokens: 300 + i,
                model: 'claude-sonnet-4-6-20250514',
            });
            state = applyStreamComplete(state, {
                inputTokens: 2000 + i * 2,
                outputTokens: 800 + i,
                model: 'claude-sonnet-4-6-20250514',
            });

            // Pricing
            calculateCost(2000 + i * 2, 800 + i, 'claude-sonnet-4-6-20250514');

            // Health
            const growth = computeGrowthRate(contextHistory);
            computeHealthScore({
                contextPct,
                turnCount: i + 1,
                growthRate: growth ?? 0,
            });

            // Context intelligence
            const ctxSignals = analyzeContext({
                turnCount: i + 1,
                contextPct,
                contextHistory: [...contextHistory],
                model: 'claude-sonnet-4-6-20250514',
                contextWindow: 200_000,
            });

            // Prompt analysis
            const promptSignals = analyzePrompt(
                { promptLength: 200 + (i % 500), hasCodeBlock: i % 3 === 0, isShortFollowUp: i % 5 === 0 },
                'claude-sonnet-4-6-20250514',
                i % 5 === 0 ? 3 : 0,
            );

            // Delta coaching
            const deltaSignals = analyzeDelta({
                currentDelta: 2 + (i % 10) * 0.5,
                recentDeltas: [2, 2.5, 3, 3.5, 2 + (i % 10) * 0.5],
                sessionPct: Math.min(99, i / 10),
                firstTurnDelta: 2,
                turnCount: i + 1,
            });

            // Signal merge
            pickTopSignal([...ctxSignals, ...promptSignals, ...deltaSignals]);
        }

        tryGC();
        const after = heapMB();
        const growthMB = after - before;

        console.log(`Full pipeline after 1000 cycles: growth=${growthMB.toFixed(2)}MB`);
        // Pure functions with bounded inputs; should stay well under 10MB.
        expect(growthMB).toBeLessThan(10);
    });
});

describe('memory: array growth patterns', () => {
    test('contextHistory stays bounded when caller caps it', () => {
        // Simulates how the orchestrator should manage contextHistory.
        // The agent (analyzeContext) receives a snapshot; it never grows the array itself.
        const history: number[] = [];
        const MAX = 50;

        for (let i = 0; i < 500; i++) {
            history.push(i);
            if (history.length > MAX) history.shift();
            analyzeContext({
                turnCount: i + 1,
                contextPct: Math.min(99, i / 5),
                contextHistory: history,
                model: 'claude-sonnet-4-6-20250514',
                contextWindow: 200_000,
            });
        }

        expect(history.length).toBeLessThanOrEqual(MAX);
    });
});
