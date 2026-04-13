// tests/perf/benchmarks.test.ts
// Performance benchmarks for critical-path functions.
// Run: bun test tests/perf/benchmarks.test.ts --reporter=verbose

import { bench, describe } from 'vitest';
import { calculateCost, lookupModel, getContextWindowSize } from '../../lib/pricing';
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
import type { ContextSignal } from '../../lib/context-intelligence';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN_BATCH_MSG = {
    namespace: 'LCO_V1',
    token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    type: 'TOKEN_BATCH' as const,
    inputTokens: 1200,
    outputTokens: 340,
    model: 'claude-sonnet-4-6-20250514',
};

const STREAM_COMPLETE_MSG = {
    namespace: 'LCO_V1',
    token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    type: 'STREAM_COMPLETE' as const,
    inputTokens: 3400,
    outputTokens: 1200,
    model: 'claude-sonnet-4-6-20250514',
    promptLength: 450,
    hasCodeBlock: true,
    isShortFollowUp: false,
};

const CONVERSATION_STATE = {
    turnCount: 12,
    contextPct: 65,
    contextHistory: [10, 18, 25, 33, 40, 45, 50, 54, 57, 60, 63, 65],
    model: 'claude-sonnet-4-6-20250514',
    contextWindow: 200_000,
};

const DELTA_INPUT = {
    currentDelta: 3.2,
    recentDeltas: [2.1, 2.5, 2.8, 3.0, 3.2],
    sessionPct: 42,
    firstTurnDelta: 2.1,
    turnCount: 5,
};

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('bridge validation', () => {
    bench('isValidBridgeSchema - TOKEN_BATCH', () => {
        isValidBridgeSchema(TOKEN_BATCH_MSG);
    });

    bench('isValidBridgeSchema - STREAM_COMPLETE', () => {
        isValidBridgeSchema(STREAM_COMPLETE_MSG);
    });

    bench('isValidBridgeSchema - invalid (reject)', () => {
        isValidBridgeSchema({ type: 'UNKNOWN', garbage: true });
    });
});

describe('pricing', () => {
    bench('lookupModel - known model', () => {
        lookupModel('claude-sonnet-4-6-20250514');
    });

    bench('lookupModel - unknown model', () => {
        lookupModel('unknown-model-v99');
    });

    bench('calculateCost - single message', () => {
        calculateCost(3400, 1200, 'claude-sonnet-4-6-20250514');
    });

    bench('getContextWindowSize', () => {
        getContextWindowSize('claude-sonnet-4-6-20250514');
    });
});

describe('health score', () => {
    bench('computeHealthScore - healthy', () => {
        computeHealthScore({ contextPct: 30, turnCount: 5, growthRate: 3 });
    });

    bench('computeHealthScore - degrading', () => {
        computeHealthScore({ contextPct: 65, turnCount: 15, growthRate: 6 });
    });

    bench('computeHealthScore - critical', () => {
        computeHealthScore({ contextPct: 92, turnCount: 25, growthRate: 10 });
    });

    bench('computeGrowthRate - 12 data points', () => {
        computeGrowthRate(CONVERSATION_STATE.contextHistory);
    });
});

describe('context intelligence', () => {
    bench('analyzeContext - mid conversation', () => {
        analyzeContext(CONVERSATION_STATE);
    });

    bench('analyzeContext - critical state', () => {
        analyzeContext({
            ...CONVERSATION_STATE,
            contextPct: 92,
            turnCount: 28,
            contextHistory: [...CONVERSATION_STATE.contextHistory, 70, 78, 85, 92],
        });
    });

    bench('pickTopSignal - 5 signals', () => {
        const signals: ContextSignal[] = [
            { type: 'project_hint', severity: 'info', message: 'a', dismissible: true },
            { type: 'stale_conversation', severity: 'info', message: 'b', dismissible: true },
            { type: 'growth_warning', severity: 'warning', message: 'c', dismissible: true },
            { type: 'threshold', severity: 'warning', message: 'd', dismissible: false },
            { type: 'threshold', severity: 'critical', message: 'e', dismissible: false },
        ];
        pickTopSignal(signals);
    });
});

describe('prompt analysis', () => {
    bench('analyzePrompt - short follow-up', () => {
        analyzePrompt(
            { promptLength: 30, hasCodeBlock: false, isShortFollowUp: true },
            'claude-sonnet-4-6-20250514',
            4,
        );
    });

    bench('analyzePrompt - large paste with code', () => {
        analyzePrompt(
            { promptLength: 2500, hasCodeBlock: true, isShortFollowUp: false },
            'claude-opus-4-6-20250514',
            0,
        );
    });
});

describe('delta coaching', () => {
    bench('analyzeDelta - mid session', () => {
        analyzeDelta(DELTA_INPUT);
    });

    bench('analyzeDelta - near exhaustion', () => {
        analyzeDelta({
            currentDelta: 8.5,
            recentDeltas: [6.0, 7.0, 7.5, 8.0, 8.5],
            sessionPct: 88,
            firstTurnDelta: 3.0,
            turnCount: 12,
        });
    });
});

describe('overlay state transitions', () => {
    bench('applyTokenBatch', () => {
        applyTokenBatch(INITIAL_STATE, {
            inputTokens: 1200,
            outputTokens: 340,
            model: 'claude-sonnet-4-6-20250514',
        });
    });

    bench('applyStreamComplete', () => {
        applyStreamComplete(INITIAL_STATE, {
            inputTokens: 3400,
            outputTokens: 1200,
            model: 'claude-sonnet-4-6-20250514',
        });
    });

    bench('applyMessageLimit', () => {
        applyMessageLimit(INITIAL_STATE, 0.45);
    });

    bench('full pipeline: batch + complete + message limit', () => {
        let s: OverlayState = INITIAL_STATE;
        s = applyTokenBatch(s, { inputTokens: 500, outputTokens: 100, model: 'claude-sonnet-4-6-20250514' });
        s = applyTokenBatch(s, { inputTokens: 1200, outputTokens: 340, model: 'claude-sonnet-4-6-20250514' });
        s = applyStreamComplete(s, { inputTokens: 3400, outputTokens: 1200, model: 'claude-sonnet-4-6-20250514' });
        s = applyMessageLimit(s, 0.52);
    });
});

describe('session accumulation', () => {
    bench('100 messages through overlay state', () => {
        let state: OverlayState = INITIAL_STATE;
        for (let i = 0; i < 100; i++) {
            state = applyTokenBatch(state, {
                inputTokens: 1000 + i * 50,
                outputTokens: 300 + i * 20,
                model: 'claude-sonnet-4-6-20250514',
            });
            state = applyStreamComplete(state, {
                inputTokens: 2000 + i * 100,
                outputTokens: 800 + i * 40,
                model: 'claude-sonnet-4-6-20250514',
            });
        }
    });
});

describe('full agent pipeline (single turn)', () => {
    bench('all agents: health + context + prompt + delta + pricing', () => {
        // Pricing
        calculateCost(3400, 1200, 'claude-sonnet-4-6-20250514');
        // Health
        const growth = computeGrowthRate(CONVERSATION_STATE.contextHistory);
        computeHealthScore({ contextPct: 65, turnCount: 12, growthRate: growth ?? 0 });
        // Context intelligence
        const ctxSignals = analyzeContext(CONVERSATION_STATE);
        // Prompt analysis
        const promptSignals = analyzePrompt(
            { promptLength: 450, hasCodeBlock: true, isShortFollowUp: false },
            'claude-sonnet-4-6-20250514',
            0,
        );
        // Delta coaching
        const deltaSignals = analyzeDelta(DELTA_INPUT);
        // Signal merge
        pickTopSignal([...ctxSignals, ...promptSignals, ...deltaSignals]);
    });
});
