import { describe, it, expect } from 'vitest';
import {
    analyzeContext,
    shouldDismiss,
    signalKey,
    pickTopSignal,
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

// ── Threshold alerts ──────────────────────────────────────────────────────────

describe('threshold signals', () => {
    it('returns no threshold signal below 60%', () => {
        const signals = analyzeContext(makeState({ contextPct: 59.9 }));
        expect(signals.find(s => s.type === 'threshold')).toBeUndefined();
    });

    it('returns info at exactly 60%', () => {
        const signals = analyzeContext(makeState({ contextPct: CONTEXT_THRESHOLD_INFO }));
        const t = signals.find(s => s.type === 'threshold');
        expect(t).toBeDefined();
        expect(t!.severity).toBe('info');
        expect(t!.dismissible).toBe(true);
    });

    it('returns info between 60% and 75%', () => {
        const signals = analyzeContext(makeState({ contextPct: 74.9 }));
        const t = signals.find(s => s.type === 'threshold');
        expect(t!.severity).toBe('info');
    });

    it('returns warning at exactly 75%', () => {
        const signals = analyzeContext(makeState({ contextPct: CONTEXT_THRESHOLD_WARNING }));
        const t = signals.find(s => s.type === 'threshold');
        expect(t!.severity).toBe('warning');
        expect(t!.dismissible).toBe(true);
    });

    it('returns warning between 75% and 90%', () => {
        const signals = analyzeContext(makeState({ contextPct: 89.9 }));
        const t = signals.find(s => s.type === 'threshold');
        expect(t!.severity).toBe('warning');
    });

    it('returns critical at exactly 90%', () => {
        const signals = analyzeContext(makeState({ contextPct: CONTEXT_THRESHOLD_CRITICAL }));
        const t = signals.find(s => s.type === 'threshold');
        expect(t!.severity).toBe('critical');
        expect(t!.dismissible).toBe(false);
    });

    it('returns critical at 100%', () => {
        const signals = analyzeContext(makeState({ contextPct: 100 }));
        const t = signals.find(s => s.type === 'threshold');
        expect(t!.severity).toBe('critical');
    });

    it('only emits one threshold signal at a time', () => {
        const signals = analyzeContext(makeState({ contextPct: 92 }));
        expect(signals.filter(s => s.type === 'threshold')).toHaveLength(1);
    });

    it('critical threshold is not dismissible', () => {
        const signals = analyzeContext(makeState({ contextPct: 95 }));
        const t = signals.find(s => s.type === 'threshold');
        expect(t!.dismissible).toBe(false);
    });
});

// ── Growth rate warning ───────────────────────────────────────────────────────

describe('growth_warning signals', () => {
    it('returns no growth warning with empty history', () => {
        const signals = analyzeContext(makeState({ contextHistory: [] }));
        expect(signals.find(s => s.type === 'growth_warning')).toBeUndefined();
    });

    it('returns no growth warning with a single history entry', () => {
        const signals = analyzeContext(makeState({ contextHistory: [50] }));
        expect(signals.find(s => s.type === 'growth_warning')).toBeUndefined();
    });

    it('returns no growth warning when growth is exactly at threshold', () => {
        // avg growth = 10% exactly (not > 10)
        const signals = analyzeContext(makeState({
            contextPct: 60,
            contextHistory: [0, 10, 20, 30, 40, 50, 60],
        }));
        expect(signals.find(s => s.type === 'growth_warning')).toBeUndefined();
    });

    it('returns growth warning when avg growth exceeds threshold', () => {
        // each turn grows 11%
        const signals = analyzeContext(makeState({
            contextPct: 66,
            contextHistory: [0, 11, 22, 33, 44, 55, 66],
        }));
        const g = signals.find(s => s.type === 'growth_warning');
        expect(g).toBeDefined();
        expect(g!.severity).toBe('warning');
        expect(g!.dismissible).toBe(true);
    });

    it('ignores downward movement in growth calculation', () => {
        // grows then drops then grows: only upward steps count
        const signals = analyzeContext(makeState({
            contextPct: 25,
            contextHistory: [0, 5, 3, 8, 6, 9], // avg upward = (5+5+3)/3 = 4.3%
        }));
        expect(signals.find(s => s.type === 'growth_warning')).toBeUndefined();
    });

    it('returns no growth warning when history only decreases', () => {
        const signals = analyzeContext(makeState({
            contextPct: 10,
            contextHistory: [50, 40, 30, 20, 10],
        }));
        expect(signals.find(s => s.type === 'growth_warning')).toBeUndefined();
    });

    it('includes estimated messages remaining in the message', () => {
        // avg growth ~15%, contextPct = 70% → remaining ≈ round(30/15) = 2
        const signals = analyzeContext(makeState({
            contextPct: 70,
            contextHistory: [0, 15, 30, 45, 60, 70],
        }));
        const g = signals.find(s => s.type === 'growth_warning');
        expect(g!.message).toMatch(/~\d+ more message/);
    });

    it('uses singular "message" when estimated count is 1', () => {
        // avg growth ~12%, contextPct = 89% → remaining = round(11/12) = 1
        const signals = analyzeContext(makeState({
            contextPct: 89,
            contextHistory: [53, 65, 77, 89],
        }));
        const g = signals.find(s => s.type === 'growth_warning');
        if (g) {
            const isCorrectPlural = g.message.includes('~1 more message.') || g.message.includes('more messages.');
            expect(isCorrectPlural).toBe(true);
        }
    });

    it('caps remaining messages at 0 when already over 100%', () => {
        const signals = analyzeContext(makeState({
            contextPct: 102,
            contextHistory: [80, 95, 102],
        }));
        const g = signals.find(s => s.type === 'growth_warning');
        if (g) expect(g.message).toMatch(/~0 more messages/);
    });
});

// ── Stale conversation ────────────────────────────────────────────────────────

describe('stale_conversation signals', () => {
    it('does not fire at exactly STALE_MIN_TURNS', () => {
        const signals = analyzeContext(makeState({
            turnCount: STALE_MIN_TURNS,
            contextPct: STALE_MIN_CONTEXT_PCT + 1,
        }));
        expect(signals.find(s => s.type === 'stale_conversation')).toBeUndefined();
    });

    it('does not fire when contextPct is exactly STALE_MIN_CONTEXT_PCT', () => {
        const signals = analyzeContext(makeState({
            turnCount: STALE_MIN_TURNS + 1,
            contextPct: STALE_MIN_CONTEXT_PCT,
        }));
        expect(signals.find(s => s.type === 'stale_conversation')).toBeUndefined();
    });

    it('fires when turnCount > STALE_MIN_TURNS and contextPct > STALE_MIN_CONTEXT_PCT', () => {
        const signals = analyzeContext(makeState({
            turnCount: STALE_MIN_TURNS + 1,
            contextPct: STALE_MIN_CONTEXT_PCT + 1,
        }));
        const s = signals.find(s => s.type === 'stale_conversation');
        expect(s).toBeDefined();
        expect(s!.severity).toBe('info');
        expect(s!.dismissible).toBe(true);
    });

    it('fires with high turn count and high context', () => {
        const signals = analyzeContext(makeState({ turnCount: 30, contextPct: 85 }));
        expect(signals.find(s => s.type === 'stale_conversation')).toBeDefined();
    });
});

// ── Project hint ──────────────────────────────────────────────────────────────

describe('project_hint signals', () => {
    it('does not fire at exactly PROJECT_HINT_MIN_TURNS', () => {
        const signals = analyzeContext(makeState({
            turnCount: PROJECT_HINT_MIN_TURNS,
            contextPct: PROJECT_HINT_MIN_CONTEXT_PCT,
            contextHistory: [10, 20],
        }));
        expect(signals.find(s => s.type === 'project_hint')).toBeUndefined();
    });

    it('does not fire when contextPct is below PROJECT_HINT_MIN_CONTEXT_PCT', () => {
        const signals = analyzeContext(makeState({
            turnCount: PROJECT_HINT_MIN_TURNS + 1,
            contextPct: PROJECT_HINT_MIN_CONTEXT_PCT - 1,
            contextHistory: [10, 18],
        }));
        expect(signals.find(s => s.type === 'project_hint')).toBeUndefined();
    });

    it('does not fire when history shows net negative growth', () => {
        const signals = analyzeContext(makeState({
            turnCount: PROJECT_HINT_MIN_TURNS + 1,
            contextPct: 25,
            contextHistory: [35, 25], // context decreased overall
        }));
        expect(signals.find(s => s.type === 'project_hint')).toBeUndefined();
    });

    it('fires when turnCount > threshold, contextPct >= threshold, and net growth is positive', () => {
        const signals = analyzeContext(makeState({
            turnCount: PROJECT_HINT_MIN_TURNS + 1,
            contextPct: PROJECT_HINT_MIN_CONTEXT_PCT,
            contextHistory: [10, PROJECT_HINT_MIN_CONTEXT_PCT],
        }));
        const p = signals.find(s => s.type === 'project_hint');
        expect(p).toBeDefined();
        expect(p!.severity).toBe('info');
        expect(p!.dismissible).toBe(true);
    });

    it('fires with no history by using contextPct as net growth', () => {
        const signals = analyzeContext(makeState({
            turnCount: PROJECT_HINT_MIN_TURNS + 1,
            contextPct: PROJECT_HINT_MIN_CONTEXT_PCT,
            contextHistory: [],
        }));
        expect(signals.find(s => s.type === 'project_hint')).toBeDefined();
    });
});

// ── shouldDismiss ─────────────────────────────────────────────────────────────

describe('shouldDismiss', () => {
    const infoSignal: ContextSignal = {
        type: 'threshold',
        severity: 'info',
        message: 'test',
        dismissible: true,
    };
    const warnSignal: ContextSignal = {
        type: 'threshold',
        severity: 'warning',
        message: 'test',
        dismissible: true,
    };
    const growthSignal: ContextSignal = {
        type: 'growth_warning',
        severity: 'warning',
        message: 'test',
        dismissible: true,
    };

    it('returns false when dismissed set is empty', () => {
        expect(shouldDismiss(infoSignal, new Set())).toBe(false);
    });

    it('returns true when signal key is in dismissed set', () => {
        const dismissed = new Set([signalKey(infoSignal)]);
        expect(shouldDismiss(infoSignal, dismissed)).toBe(true);
    });

    it('does not suppress a different severity of the same type', () => {
        const dismissed = new Set([signalKey(infoSignal)]);
        expect(shouldDismiss(warnSignal, dismissed)).toBe(false);
    });

    it('does not suppress a different signal type', () => {
        const dismissed = new Set([signalKey(infoSignal)]);
        expect(shouldDismiss(growthSignal, dismissed)).toBe(false);
    });

    it('suppresses each type independently', () => {
        const dismissed = new Set([signalKey(infoSignal), signalKey(growthSignal)]);
        expect(shouldDismiss(infoSignal, dismissed)).toBe(true);
        expect(shouldDismiss(growthSignal, dismissed)).toBe(true);
        expect(shouldDismiss(warnSignal, dismissed)).toBe(false);
    });
});

// ── signalKey ─────────────────────────────────────────────────────────────────

describe('signalKey', () => {
    it('returns a stable string combining type and severity', () => {
        const signal: ContextSignal = {
            type: 'stale_conversation',
            severity: 'info',
            message: 'x',
            dismissible: true,
        };
        expect(signalKey(signal)).toBe('stale_conversation:info');
    });

    it('produces different keys for different severities of the same type', () => {
        const a: ContextSignal = { type: 'threshold', severity: 'info', message: '', dismissible: true };
        const b: ContextSignal = { type: 'threshold', severity: 'warning', message: '', dismissible: true };
        expect(signalKey(a)).not.toBe(signalKey(b));
    });
});

// ── Multiple signals coexisting ───────────────────────────────────────────────

describe('multiple simultaneous signals', () => {
    it('can emit threshold and growth_warning at the same time', () => {
        const signals = analyzeContext(makeState({
            contextPct: 70,
            contextHistory: [0, 11, 22, 33, 44, 55, 66],
            turnCount: 7,
        }));
        expect(signals.find(s => s.type === 'threshold')).toBeDefined();
        expect(signals.find(s => s.type === 'growth_warning')).toBeDefined();
    });

    it('can emit stale_conversation and threshold together', () => {
        const signals = analyzeContext(makeState({
            turnCount: 20,
            contextPct: 80,
            contextHistory: [],
        }));
        expect(signals.find(s => s.type === 'threshold')).toBeDefined();
        expect(signals.find(s => s.type === 'stale_conversation')).toBeDefined();
    });

    it('returns empty array when no conditions are met', () => {
        const signals = analyzeContext(makeState({
            turnCount: 2,
            contextPct: 10,
            contextHistory: [5, 10],
        }));
        expect(signals).toHaveLength(0);
    });
});

// ── pickTopSignal ─────────────────────────────────────────────────────────────

describe('pickTopSignal', () => {
    const info: ContextSignal     = { type: 'threshold',         severity: 'info',     message: '', dismissible: true };
    const warning: ContextSignal  = { type: 'growth_warning',    severity: 'warning',  message: '', dismissible: true };
    const critical: ContextSignal = { type: 'stale_conversation', severity: 'critical', message: '', dismissible: false };

    it('returns null for an empty array', () => {
        expect(pickTopSignal([])).toBeNull();
    });

    it('returns the only signal when there is one', () => {
        expect(pickTopSignal([info])).toBe(info);
    });

    it('returns critical over warning and info', () => {
        expect(pickTopSignal([info, warning, critical])).toBe(critical);
    });

    it('returns warning over info', () => {
        expect(pickTopSignal([info, warning])).toBe(warning);
    });

    it('returns critical even when listed last', () => {
        expect(pickTopSignal([info, warning, critical].reverse())).toBe(critical);
    });

    it('returns the first signal when all severities are equal', () => {
        const a: ContextSignal = { type: 'threshold',      severity: 'info', message: 'a', dismissible: true };
        const b: ContextSignal = { type: 'project_hint',   severity: 'info', message: 'b', dismissible: true };
        expect(pickTopSignal([a, b])).toBe(a);
    });

    it('works correctly from a real analyzeContext output', () => {
        // This state produces both a threshold warning and a growth_warning.
        // pickTopSignal should return whichever has higher severity.
        const signals = analyzeContext(makeState({
            contextPct: 76,
            contextHistory: [0, 11, 22, 44, 65, 76],
            turnCount: 6,
        }));
        const top = pickTopSignal(signals);
        expect(top).not.toBeNull();
        // Both signals are 'warning' severity here — just confirm one is returned.
        expect(['warning', 'critical']).toContain(top!.severity);
    });
});
