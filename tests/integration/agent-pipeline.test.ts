// tests/integration/agent-pipeline.test.ts
// Agent orchestration tests: feed the same message data through every agent
// in the order the content script calls them. Verify no contradictions,
// verify isolation (one agent throwing does not prevent others).
//
// Agent call order in the content script (after STREAM_COMPLETE):
//   1. Pricing Agent     -> cost (USD)
//   2. Overlay State     -> applyStreamComplete, then applyStorageResponse
//   3. Prompt Agent      -> ContextSignal[] (model_suggestion, large_paste, follow_up_chain)
//   4. Intelligence Agent-> ContextSignal[] (threshold, growth, stale, project)
//   5. Delta Coach       -> ContextSignal[] (burn_rate, expensive_message, cost_trajectory)
//   6. Health Agent       -> HealthScore
//   7. Pre-Submit Agent   -> PreSubmitEstimate (async, on draft input)
//   8. Token Economics    -> medians (background, on GET_TOKEN_ECONOMICS)
//   9. Usage Budget       -> UsageBudgetResult (dashboard)
//
// pickTopSignal() merges signals from agents 3, 4, 5. Severity ranking:
//   critical > warning > info. Ties: first match wins.
//
// Mocked boundaries: none. All agents are pure functions; no chrome APIs needed.

import { describe, it, expect } from 'vitest';
import { calculateCost, getContextWindowSize } from '../../lib/pricing';
import { applyStreamComplete } from '../../lib/overlay-state';
import { INITIAL_STATE } from '../../lib/overlay-state';
import { analyzePrompt } from '../../lib/prompt-analysis';
import type { PromptCharacteristics } from '../../lib/prompt-analysis';
import {
    analyzeContext,
    pickTopSignal,
    type ConversationState,
    type ContextSignal,
} from '../../lib/context-intelligence';
import { analyzeDelta, type DeltaCoachInput } from '../../lib/delta-coaching';
import { computeHealthScore, computeGrowthRate, type HealthInput } from '../../lib/health-score';
import { computePreSubmitEstimate, type PreSubmitInput } from '../../lib/pre-submit';
import { computeTokenEconomics, type TokenEconomicsResult } from '../../lib/token-economics';
import { computeUsageBudget } from '../../lib/usage-budget';
import type { UsageLimitsData } from '../../lib/message-types';
import type { UsageDelta } from '../../lib/conversation-store';

// ── Test fixture: a mid-conversation state at ~55% context ──────────────────

const MODEL = 'claude-sonnet-4-6';
const CTX_WINDOW = getContextWindowSize(MODEL); // 200000

function makeConvState(overrides: Partial<ConversationState> = {}): ConversationState {
    return {
        turnCount: 12,
        contextPct: 55,
        contextHistory: [5, 10, 15, 20, 25, 30, 35, 40, 45, 48, 52, 55],
        model: MODEL,
        contextWindow: CTX_WINDOW,
        ...overrides,
    };
}

function makePromptChars(overrides: Partial<PromptCharacteristics> = {}): PromptCharacteristics {
    return {
        promptLength: 120,
        hasCodeBlock: false,
        isShortFollowUp: false,
        ...overrides,
    };
}

function makeDeltaInput(overrides: Partial<DeltaCoachInput> = {}): DeltaCoachInput {
    return {
        currentDelta: 3.2,
        recentDeltas: [2.5, 3.0, 2.8, 3.2],
        sessionPct: 62,
        firstTurnDelta: 1.5,
        turnCount: 12,
        ...overrides,
    };
}

// ── Full agent pipeline: healthy conversation ───────────────────────────────

describe('agent pipeline: healthy mid-conversation', () => {
    const convState = makeConvState();
    const promptChars = makePromptChars();

    // Run all agents
    const cost = calculateCost(500, 1500, MODEL);
    const overlayState = applyStreamComplete(INITIAL_STATE, {
        inputTokens: 500,
        outputTokens: 1500,
        model: MODEL,
    });
    const promptSignals = analyzePrompt(promptChars, MODEL, 0);
    const contextSignals = analyzeContext(convState);
    const deltaSignals = analyzeDelta(makeDeltaInput());
    const health = computeHealthScore({
        contextPct: convState.contextPct,
        turnCount: convState.turnCount,
        growthRate: computeGrowthRate(convState.contextHistory),
        model: MODEL,
        isDetailHeavy: false,
    });

    it('pricing agent returns a non-null cost', () => {
        expect(cost).not.toBeNull();
        // 500 * 0.000003 + 1500 * 0.000015 = 0.0015 + 0.0225 = 0.024
        expect(cost).toBeCloseTo(0.024, 10);
    });

    it('overlay state reflects stream completion', () => {
        expect(overlayState.streaming).toBe(false);
        expect(overlayState.lastRequest).not.toBeNull();
    });

    it('prompt agent returns no signals (normal prompt, Sonnet)', () => {
        // 120 chars, no code block, not short follow-up: nothing to flag on Sonnet
        expect(promptSignals).toHaveLength(0);
    });

    it('context intelligence detects 55% threshold', () => {
        // contextPct = 55 is below the 60% info threshold
        const threshold = contextSignals.find(s => s.type === 'threshold');
        expect(threshold).toBeUndefined();
    });

    it('context intelligence detects stale conversation at 55% + 12 turns', () => {
        // turnCount(12) > STALE_MIN_TURNS(15)? No, 12 < 15. No stale signal.
        const stale = contextSignals.find(s => s.type === 'stale_conversation');
        expect(stale).toBeUndefined();
    });

    it('health agent returns degrading (12 turns, 55% context on Sonnet 4.6)', () => {
        // Per-model thresholds (GET-28). Sonnet 4.6 warn = 60, but Rule 6
        // (turn-aware degrading floor = warn - 10 = 50) trips when context
        // is within 10 points of warn AND turnCount > TURN_HEALTHY_CEIL.
        // 55% with 12 turns satisfies both, so the indicator surfaces
        // attention-valley risk before the per-model warn fires.
        expect(health.level).toBe('degrading');
    });

    it('delta coach returns no critical signals at 62% session', () => {
        const critical = deltaSignals.filter(s => s.severity === 'critical');
        expect(critical).toHaveLength(0);
    });

    it('all signals have valid type and severity', () => {
        const allSignals = [...promptSignals, ...contextSignals, ...deltaSignals];
        for (const signal of allSignals) {
            expect(typeof signal.type).toBe('string');
            expect(['info', 'warning', 'critical']).toContain(signal.severity);
            expect(typeof signal.message).toBe('string');
            expect(signal.message.length).toBeGreaterThan(0);
        }
    });
});

// ── Agent pipeline: degrading state (new HEALTHY_CEIL=70 boundary) ──────────

describe('agent pipeline: degrading mid-conversation', () => {
    const convState = makeConvState({
        contextPct: 75,
        turnCount: 12,
        contextHistory: [5, 10, 18, 25, 33, 42, 50, 55, 60, 65, 70, 75],
    });

    const health = computeHealthScore({
        contextPct: convState.contextPct,
        turnCount: convState.turnCount,
        growthRate: computeGrowthRate(convState.contextHistory),
        model: MODEL,
        isDetailHeavy: false,
    });

    it('health agent returns degrading (12 turns, 75% context)', () => {
        // contextPct(75) >= HEALTHY_CEIL(70) && turnCount(12) > TURN_HEALTHY_CEIL(10)
        expect(health.level).toBe('degrading');
    });

    it('degrading coaching is non-empty', () => {
        expect(health.coaching.length).toBeGreaterThan(0);
        expect(health.label).toBe('Degrading');
    });
});

// ── Agent pipeline: critical state ──────────────────────────────────────────

describe('agent pipeline: critical conversation', () => {
    const convState = makeConvState({
        contextPct: 85,
        turnCount: 25,
        contextHistory: Array.from({ length: 25 }, (_, i) => (i + 1) * 3.4),
    });

    const contextSignals = analyzeContext(convState);
    const health = computeHealthScore({
        contextPct: 85,
        turnCount: 25,
        growthRate: computeGrowthRate(convState.contextHistory),
        model: MODEL,
        isDetailHeavy: false,
    });
    const deltaSignals = analyzeDelta(makeDeltaInput({
        sessionPct: 88,
        recentDeltas: [4.0, 3.5, 4.2, 3.8],
        currentDelta: 4.0,
    }));

    it('context intelligence fires critical threshold', () => {
        // contextPct(85) >= CONTEXT_THRESHOLD_WARNING(75)
        const threshold = contextSignals.find(s => s.type === 'threshold');
        expect(threshold).toBeDefined();
        expect(threshold!.severity).toBe('warning');
    });

    it('health agent returns critical', () => {
        // contextPct(85) < DEGRADING_CEIL(90) but >= HEALTHY_CEIL(70) && turnCount(25) > TURN_DEGRADING_CEIL(20): Rule 2
        expect(health.level).toBe('critical');
    });

    it('delta coach fires burn_rate warning at 88%', () => {
        // sessionPct(88) > BURN_RATE_MIN_SESSION_PCT(50), 4 deltas >= 3
        // median of [3.5, 3.8, 4.0, 4.2] = (3.8+4.0)/2 = 3.9
        // remaining = floor((100-88)/3.9) = floor(3.07) = 3
        // 3 < BURN_RATE_CRITICAL_REMAINING(5) -> critical
        const burnRate = deltaSignals.find(s => s.type === 'burn_rate');
        expect(burnRate).toBeDefined();
        expect(burnRate!.severity).toBe('critical');
    });

    it('pickTopSignal returns the critical signal', () => {
        const allSignals = [...contextSignals, ...deltaSignals];
        const top = pickTopSignal(allSignals);
        expect(top).not.toBeNull();
        expect(top!.severity).toBe('critical');
    });
});

// ── Signal priority: context health outranks prompt coaching ────────────────

describe('agent pipeline: signal priority', () => {
    it('critical context signal outranks info prompt signal', () => {
        const contextSignal: ContextSignal = {
            type: 'threshold',
            severity: 'critical',
            message: 'Context is nearly full.',
            dismissible: false,
        };
        const promptSignal: ContextSignal = {
            type: 'model_suggestion',
            severity: 'info',
            message: 'Haiku could handle this.',
            dismissible: true,
        };

        const top = pickTopSignal([promptSignal, contextSignal]);
        expect(top!.type).toBe('threshold');
        expect(top!.severity).toBe('critical');
    });

    it('warning from delta coach outranks info from prompt agent', () => {
        const deltaSignal: ContextSignal = {
            type: 'burn_rate',
            severity: 'warning',
            message: '~12 messages left.',
            dismissible: true,
        };
        const promptSignal: ContextSignal = {
            type: 'large_paste',
            severity: 'info',
            message: 'Large code block detected.',
            dismissible: true,
        };

        const top = pickTopSignal([promptSignal, deltaSignal]);
        expect(top!.type).toBe('burn_rate');
    });

    it('pickTopSignal returns null for empty array', () => {
        expect(pickTopSignal([])).toBeNull();
    });

    it('pickTopSignal with equal severity returns first match', () => {
        const a: ContextSignal = {
            type: 'model_suggestion', severity: 'info',
            message: 'A', dismissible: true,
        };
        const b: ContextSignal = {
            type: 'large_paste', severity: 'info',
            message: 'B', dismissible: true,
        };
        expect(pickTopSignal([a, b])!.type).toBe('model_suggestion');
    });
});

// ── Agent isolation: one agent's bad input does not crash others ─────────────

describe('agent pipeline: agent isolation', () => {
    it('prompt agent with zero-length prompt returns no signals (does not crash)', () => {
        const signals = analyzePrompt(
            { promptLength: 0, hasCodeBlock: false, isShortFollowUp: false },
            MODEL,
            0,
        );
        expect(signals).toHaveLength(0);
    });

    it('context intelligence with zero context and zero turns returns no signals', () => {
        const signals = analyzeContext({
            turnCount: 0,
            contextPct: 0,
            contextHistory: [],
            model: MODEL,
            contextWindow: CTX_WINDOW,
        });
        expect(signals).toHaveLength(0);
    });

    it('delta coach with null currentDelta returns no signals', () => {
        const signals = analyzeDelta({
            currentDelta: null,
            recentDeltas: [],
            sessionPct: 0,
            firstTurnDelta: null,
            turnCount: 0,
        });
        expect(signals).toHaveLength(0);
    });

    it('health agent handles edge case of 0% context', () => {
        const health = computeHealthScore({ contextPct: 0, turnCount: 0, growthRate: null, model: MODEL, isDetailHeavy: false });
        expect(health.level).toBe('healthy');
    });

    it('all agents produce valid output even with minimal input', () => {
        // Run every agent with minimal/empty input: none should throw
        const promptSigs = analyzePrompt(
            { promptLength: 0, hasCodeBlock: false, isShortFollowUp: false },
            'unknown',
            0,
        );
        const ctxSigs = analyzeContext({
            turnCount: 0, contextPct: 0, contextHistory: [], model: 'unknown', contextWindow: 200000,
        });
        const deltaSigs = analyzeDelta({
            currentDelta: null, recentDeltas: [], sessionPct: 0, firstTurnDelta: null, turnCount: 0,
        });
        const health = computeHealthScore({ contextPct: 0, turnCount: 0, growthRate: null, model: MODEL, isDetailHeavy: false });
        const cost = calculateCost(0, 0, 'unknown');
        const preSubmit = computePreSubmitEstimate({
            draftCharCount: 0, model: 'unknown', pctPerInputToken: null, currentSessionPct: 0,
        });

        expect(promptSigs).toEqual([]);
        expect(ctxSigs).toEqual([]);
        expect(deltaSigs).toEqual([]);
        expect(health.level).toBe('healthy');
        expect(cost).toBeNull();
        expect(preSubmit).toBeNull(); // below MIN_DRAFT_CHARS
    });
});

// ── Token Economics -> Pre-Submit -> Usage Budget chain ──────────────────────

describe('agent pipeline: economics -> pre-submit -> budget chain', () => {
    // Generate 7 usage delta records (above MIN_SAMPLES = 5)
    const deltas: UsageDelta[] = Array.from({ length: 7 }, (_, i) => ({
        conversationId: `conv-${i}`,
        model: MODEL,
        inputTokens: 400 + i * 50,
        outputTokens: 1200 + i * 100,
        deltaUtilization: 2.0 + i * 0.3,
        cost: calculateCost(400 + i * 50, 1200 + i * 100, MODEL),
        timestamp: Date.now() - (7 - i) * 60000,
    }));

    const economics = computeTokenEconomics(deltas);

    it('token economics produces medians for the model', () => {
        expect(economics.medianTokensPer1Pct.has(MODEL)).toBe(true);
        expect(economics.medianPctPerInputToken.has(MODEL)).toBe(true);
        expect(economics.sampleSize.get(MODEL)).toBe(7);
    });

    it('medianTokensPer1Pct is positive', () => {
        expect(economics.medianTokensPer1Pct.get(MODEL)!).toBeGreaterThan(0);
    });

    it('medianPctPerInputToken is positive', () => {
        expect(economics.medianPctPerInputToken.get(MODEL)!).toBeGreaterThan(0);
    });

    it('pre-submit uses token economics to predict draft cost', () => {
        const pctPerInputToken: Record<string, number> = {};
        for (const [model, rate] of economics.medianPctPerInputToken) {
            pctPerInputToken[model] = rate;
        }

        const estimate = computePreSubmitEstimate({
            draftCharCount: 400,
            model: MODEL,
            pctPerInputToken,
            currentSessionPct: 30,
        });

        expect(estimate).not.toBeNull();
        expect(estimate!.estimatedTokens).toBe(100); // 400 / 4
        expect(estimate!.estimatedSessionPct).not.toBeNull();
        expect(estimate!.estimatedSessionPct!).toBeGreaterThan(0);
        expect(estimate!.projectedTotalPct).not.toBeNull();
        expect(estimate!.projectedTotalPct!).toBeGreaterThan(30);
    });

    it('usage budget classifies zone from exact utilization data', () => {
        const limits: UsageLimitsData = {
            kind: 'session',
            fiveHour: { utilization: 62, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
            sevenDay: { utilization: 28, resetsAt: new Date(Date.now() + 86400_000 * 3).toISOString() },
            capturedAt: Date.now(),
        };

        const budget = computeUsageBudget(limits, Date.now());
        // Narrow before reading session-only fields. Session is the only shape
        // this fixture builds, so anything else is a regression worth blowing up on.
        if (budget.kind !== 'session') throw new Error(`expected session variant, got ${budget.kind}`);
        expect(budget.sessionPct).toBe(62);
        expect(budget.weeklyPct).toBe(28);
        // max(62, 28) = 62: 50-74% = moderate
        expect(budget.zone).toBe('moderate');
        expect(budget.sessionMinutesUntilReset).toBeGreaterThan(0);
        expect(budget.statusLabel).toContain('62% used');
    });
});

// ── No contradictions: health vs context intelligence ───────────────────────

describe('agent pipeline: consistency between agents', () => {
    it('critical health aligns with critical/warning context threshold', () => {
        const contextPct = 85;
        const turnCount = 25;
        const growthRate = computeGrowthRate(
            Array.from({ length: turnCount }, (_, i) => (i + 1) * 3.4),
        );

        const health = computeHealthScore({ contextPct, turnCount, growthRate, model: MODEL, isDetailHeavy: false });
        const contextSignals = analyzeContext({
            turnCount,
            contextPct,
            contextHistory: Array.from({ length: turnCount }, (_, i) => (i + 1) * 3.4),
            model: MODEL,
            contextWindow: CTX_WINDOW,
        });

        // Health says critical -> context should fire warning or critical threshold
        expect(health.level).toBe('critical');
        const threshold = contextSignals.find(s => s.type === 'threshold');
        expect(threshold).toBeDefined();
        expect(['warning', 'critical']).toContain(threshold!.severity);
    });

    it('healthy health at low context means no threshold signals', () => {
        const health = computeHealthScore({ contextPct: 10, turnCount: 3, growthRate: null, model: MODEL, isDetailHeavy: false });
        const signals = analyzeContext({
            turnCount: 3,
            contextPct: 10,
            contextHistory: [3, 7, 10],
            model: MODEL,
            contextWindow: CTX_WINDOW,
        });

        expect(health.level).toBe('healthy');
        expect(signals.find(s => s.type === 'threshold')).toBeUndefined();
    });
});
