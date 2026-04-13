import { describe, test, expect } from 'vitest';

// Audit: lib/context-intelligence.ts - threshold signals, growth, stale, project hint

import {
    analyzeContext,
    pickTopSignal,
    signalKey,
    shouldDismiss,
    CONTEXT_THRESHOLD_INFO,
    CONTEXT_THRESHOLD_WARNING,
    CONTEXT_THRESHOLD_CRITICAL,
    GROWTH_RATE_WARN_PCT,
    STALE_MIN_TURNS,
    STALE_MIN_CONTEXT_PCT,
    PROJECT_HINT_MIN_TURNS,
    PROJECT_HINT_MIN_CONTEXT_PCT,
    type ConversationState,
    type ContextSignal,
} from '../../lib/context-intelligence';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
    return {
        turnCount: 1,
        contextPct: 10,
        contextHistory: [10],
        model: 'claude-sonnet-4-6',
        contextWindow: 200000,
        ...overrides,
    };
}

// ── Threshold signals ──────────────────────────────────────────────────────

describe('threshold signals', () => {
    test('no threshold signal below 60%', () => {
        const signals = analyzeContext(makeState({ contextPct: 59 }));
        expect(signals.filter(s => s.type === 'threshold')).toHaveLength(0);
    });

    test('info at exactly 60%', () => {
        const signals = analyzeContext(makeState({ contextPct: 60 }));
        const thresh = signals.filter(s => s.type === 'threshold');
        expect(thresh).toHaveLength(1);
        expect(thresh[0].severity).toBe('info');
    });

    test('warning at 75%', () => {
        const signals = analyzeContext(makeState({ contextPct: 75 }));
        const thresh = signals.filter(s => s.type === 'threshold');
        expect(thresh).toHaveLength(1);
        expect(thresh[0].severity).toBe('warning');
    });

    test('critical at 90%', () => {
        const signals = analyzeContext(makeState({ contextPct: 90 }));
        const thresh = signals.filter(s => s.type === 'threshold');
        expect(thresh).toHaveLength(1);
        expect(thresh[0].severity).toBe('critical');
    });

    test('only one threshold signal fires (highest severity wins)', () => {
        // At 95%, critical fires but not warning or info
        const signals = analyzeContext(makeState({ contextPct: 95 }));
        const thresh = signals.filter(s => s.type === 'threshold');
        expect(thresh).toHaveLength(1);
        expect(thresh[0].severity).toBe('critical');
    });

    test('critical threshold is not dismissible', () => {
        const signals = analyzeContext(makeState({ contextPct: 95 }));
        const thresh = signals.find(s => s.type === 'threshold');
        expect(thresh!.dismissible).toBe(false);
    });
});

// ── Growth warning ─────────────────────────────────────────────────────────

describe('growth warning', () => {
    test('no growth warning with insufficient history', () => {
        const signals = analyzeContext(makeState({ contextHistory: [10] }));
        expect(signals.filter(s => s.type === 'growth_warning')).toHaveLength(0);
    });

    test('no growth warning when growth <= threshold', () => {
        // Two points: 10 -> 20. Growth = 10. Threshold is 10. Should NOT fire (must exceed).
        const signals = analyzeContext(makeState({ contextPct: 20, contextHistory: [10, 20] }));
        expect(signals.filter(s => s.type === 'growth_warning')).toHaveLength(0);
    });

    test('fires when average growth exceeds threshold', () => {
        // 10 -> 25: growth = 15 > 10
        const signals = analyzeContext(makeState({ contextPct: 25, contextHistory: [10, 25] }));
        const gw = signals.filter(s => s.type === 'growth_warning');
        expect(gw).toHaveLength(1);
        expect(gw[0].severity).toBe('warning');
    });

    test('remaining messages count is correct', () => {
        // Context at 40%, growth 15/turn -> remaining = (100-40)/15 = 4
        const signals = analyzeContext(makeState({ contextPct: 40, contextHistory: [25, 40] }));
        const gw = signals.find(s => s.type === 'growth_warning');
        expect(gw!.message).toMatch(/~4 more message/);
    });
});

// ── Stale conversation ─────────────────────────────────────────────────────

describe('stale conversation', () => {
    test('fires when turns > 15 AND context > 50%', () => {
        const signals = analyzeContext(makeState({ turnCount: 16, contextPct: 51 }));
        expect(signals.filter(s => s.type === 'stale_conversation')).toHaveLength(1);
    });

    test('does not fire at exactly 15 turns', () => {
        const signals = analyzeContext(makeState({ turnCount: 15, contextPct: 55 }));
        expect(signals.filter(s => s.type === 'stale_conversation')).toHaveLength(0);
    });

    test('does not fire at exactly 50% context', () => {
        const signals = analyzeContext(makeState({ turnCount: 20, contextPct: 50 }));
        expect(signals.filter(s => s.type === 'stale_conversation')).toHaveLength(0);
    });
});

// ── Project hint ───────────────────────────────────────────────────────────

describe('project hint', () => {
    test('fires when turns > 8, context >= 20%, and net growth > 0', () => {
        const signals = analyzeContext(makeState({
            turnCount: 9, contextPct: 25, contextHistory: [10, 15, 25],
        }));
        expect(signals.filter(s => s.type === 'project_hint')).toHaveLength(1);
    });

    test('does not fire with no net growth', () => {
        const signals = analyzeContext(makeState({
            turnCount: 10, contextPct: 25, contextHistory: [25, 20, 25],
        }));
        // Net growth = 25-25 = 0, should not fire
        expect(signals.filter(s => s.type === 'project_hint')).toHaveLength(0);
    });

    test('does not fire below turn threshold', () => {
        const signals = analyzeContext(makeState({
            turnCount: 8, contextPct: 25, contextHistory: [10, 25],
        }));
        expect(signals.filter(s => s.type === 'project_hint')).toHaveLength(0);
    });
});

// ── pickTopSignal ──────────────────────────────────────────────────────────

describe('pickTopSignal', () => {
    test('returns null for empty array', () => {
        expect(pickTopSignal([])).toBeNull();
    });

    test('returns the only signal when array has one element', () => {
        const signal: ContextSignal = { type: 'threshold', severity: 'info', message: 'test', dismissible: true };
        expect(pickTopSignal([signal])).toBe(signal);
    });

    test('critical outranks warning', () => {
        const warning: ContextSignal = { type: 'threshold', severity: 'warning', message: 'w', dismissible: true };
        const critical: ContextSignal = { type: 'threshold', severity: 'critical', message: 'c', dismissible: false };
        expect(pickTopSignal([warning, critical])).toBe(critical);
    });

    test('warning outranks info', () => {
        const info: ContextSignal = { type: 'project_hint', severity: 'info', message: 'i', dismissible: true };
        const warning: ContextSignal = { type: 'growth_warning', severity: 'warning', message: 'w', dismissible: true };
        expect(pickTopSignal([info, warning])).toBe(warning);
    });

    test('first match wins on tie', () => {
        const a: ContextSignal = { type: 'threshold', severity: 'warning', message: 'first', dismissible: true };
        const b: ContextSignal = { type: 'growth_warning', severity: 'warning', message: 'second', dismissible: true };
        expect(pickTopSignal([a, b])).toBe(a);
    });
});

// ── signalKey / shouldDismiss ──────────────────────────────────────────────

describe('signalKey and shouldDismiss', () => {
    test('signalKey format is type:severity', () => {
        const signal: ContextSignal = { type: 'threshold', severity: 'warning', message: 't', dismissible: true };
        expect(signalKey(signal)).toBe('threshold:warning');
    });

    test('shouldDismiss returns true when key is in dismissed set', () => {
        const signal: ContextSignal = { type: 'threshold', severity: 'info', message: 't', dismissible: true };
        const dismissed = new Set(['threshold:info']);
        expect(shouldDismiss(signal, dismissed)).toBe(true);
    });

    test('shouldDismiss returns false when key is not in dismissed set', () => {
        const signal: ContextSignal = { type: 'threshold', severity: 'info', message: 't', dismissible: true };
        const dismissed = new Set(['threshold:warning']);
        expect(shouldDismiss(signal, dismissed)).toBe(false);
    });
});
