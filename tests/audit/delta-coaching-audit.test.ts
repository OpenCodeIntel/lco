import { describe, test, expect } from 'vitest';

// Audit: lib/delta-coaching.ts - burn rate, expensive message, cost trajectory

import {
    analyzeDelta,
    BURN_RATE_WARN_REMAINING,
    BURN_RATE_CRITICAL_REMAINING,
    BURN_RATE_MIN_DELTAS,
    BURN_RATE_MIN_SESSION_PCT,
    EXPENSIVE_MSG_MULTIPLIER,
    EXPENSIVE_MSG_MIN_DELTAS,
    TRAJECTORY_MULTIPLIER,
    TRAJECTORY_MIN_TURNS,
    type DeltaCoachInput,
} from '../../lib/delta-coaching';

function makeInput(overrides: Partial<DeltaCoachInput> = {}): DeltaCoachInput {
    return {
        currentDelta: null,
        recentDeltas: [],
        sessionPct: 0,
        firstTurnDelta: null,
        turnCount: 0,
        ...overrides,
    };
}

// ── Burn rate prediction ───────────────────────────────────────────────────

describe('burn rate', () => {
    test('no signal with insufficient deltas', () => {
        const signals = analyzeDelta(makeInput({
            recentDeltas: [5, 5], // only 2, need 3
            sessionPct: 60,
        }));
        expect(signals.filter(s => s.type === 'burn_rate')).toHaveLength(0);
    });

    test('no signal when session < 50%', () => {
        const signals = analyzeDelta(makeInput({
            recentDeltas: [5, 5, 5],
            sessionPct: 49,
        }));
        expect(signals.filter(s => s.type === 'burn_rate')).toHaveLength(0);
    });

    test('warning when remaining < 15 messages', () => {
        // Median delta = 5, sessionPct = 80, remaining = (100-80)/5 = 4
        const signals = analyzeDelta(makeInput({
            recentDeltas: [5, 5, 5],
            sessionPct: 80,
        }));
        const br = signals.filter(s => s.type === 'burn_rate');
        expect(br).toHaveLength(1);
        expect(br[0].severity).toBe('critical'); // 4 < 5 = critical
    });

    test('critical when remaining < 5 messages', () => {
        // Median = 10, sessionPct = 70, remaining = 30/10 = 3
        const signals = analyzeDelta(makeInput({
            recentDeltas: [10, 10, 10],
            sessionPct: 70,
        }));
        const br = signals.filter(s => s.type === 'burn_rate');
        expect(br).toHaveLength(1);
        expect(br[0].severity).toBe('critical');
    });

    test('warning level when remaining between 5 and 14', () => {
        // Median = 4, sessionPct = 55, remaining = 45/4 = 11
        const signals = analyzeDelta(makeInput({
            recentDeltas: [4, 4, 4],
            sessionPct: 55,
        }));
        const br = signals.filter(s => s.type === 'burn_rate');
        expect(br).toHaveLength(1);
        expect(br[0].severity).toBe('warning');
    });

    test('no signal when remaining >= 15', () => {
        // Median = 2, sessionPct = 55, remaining = 45/2 = 22
        const signals = analyzeDelta(makeInput({
            recentDeltas: [2, 2, 2],
            sessionPct: 55,
        }));
        expect(signals.filter(s => s.type === 'burn_rate')).toHaveLength(0);
    });

    test('burn rate uses median, not mean', () => {
        // Deltas: [1, 1, 100]. Mean=34, Median=1. At 55%, remaining by median = 45/1 = 45 (no signal)
        const signals = analyzeDelta(makeInput({
            recentDeltas: [1, 1, 100],
            sessionPct: 55,
        }));
        expect(signals.filter(s => s.type === 'burn_rate')).toHaveLength(0);
    });

    test('does not mutate recentDeltas input (median sorts in place)', () => {
        const deltas = [3, 1, 2, 5, 4];
        const copy = [...deltas];
        analyzeDelta(makeInput({ recentDeltas: deltas, sessionPct: 55 }));
        // analyzeDelta should spread before sorting internally
        expect(deltas).toEqual(copy);
    });
});

// ── Expensive message ──────────────────────────────────────────────────────

describe('expensive message', () => {
    test('fires when current > 2x median', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 15,
            recentDeltas: [3, 3, 3],
            sessionPct: 30,
        }));
        const exp = signals.filter(s => s.type === 'expensive_message');
        expect(exp).toHaveLength(1);
        expect(exp[0].severity).toBe('info');
    });

    test('does not fire when current = 2x median (boundary)', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 6,
            recentDeltas: [3, 3, 3],
            sessionPct: 30,
        }));
        expect(signals.filter(s => s.type === 'expensive_message')).toHaveLength(0);
    });

    test('does not fire with null currentDelta', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: null,
            recentDeltas: [3, 3, 3],
            sessionPct: 30,
        }));
        expect(signals.filter(s => s.type === 'expensive_message')).toHaveLength(0);
    });

    test('does not fire with insufficient deltas', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 20,
            recentDeltas: [3, 3],
            sessionPct: 30,
        }));
        expect(signals.filter(s => s.type === 'expensive_message')).toHaveLength(0);
    });
});

// ── Cost trajectory ────────────────────────────────────────────────────────

describe('cost trajectory', () => {
    test('fires when current > 2x first turn and turns > 5', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 5,
            firstTurnDelta: 2,
            turnCount: 6,
        }));
        const traj = signals.filter(s => s.type === 'cost_trajectory');
        expect(traj).toHaveLength(1);
        expect(traj[0].severity).toBe('warning');
    });

    test('does not fire at exactly 2x (boundary)', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 4,
            firstTurnDelta: 2,
            turnCount: 6,
        }));
        expect(signals.filter(s => s.type === 'cost_trajectory')).toHaveLength(0);
    });

    test('does not fire with <= 5 turns', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 10,
            firstTurnDelta: 2,
            turnCount: 5,
        }));
        expect(signals.filter(s => s.type === 'cost_trajectory')).toHaveLength(0);
    });

    test('does not fire with null firstTurnDelta', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 10,
            firstTurnDelta: null,
            turnCount: 10,
        }));
        expect(signals.filter(s => s.type === 'cost_trajectory')).toHaveLength(0);
    });

    test('does not fire with null currentDelta', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: null,
            firstTurnDelta: 2,
            turnCount: 10,
        }));
        expect(signals.filter(s => s.type === 'cost_trajectory')).toHaveLength(0);
    });

    test('does not fire when firstTurnDelta is 0', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 5,
            firstTurnDelta: 0,
            turnCount: 10,
        }));
        expect(signals.filter(s => s.type === 'cost_trajectory')).toHaveLength(0);
    });
});

// ── Graceful degradation ───────────────────────────────────────────────────

describe('graceful degradation', () => {
    test('all-null input returns empty signals', () => {
        const signals = analyzeDelta(makeInput());
        expect(signals).toEqual([]);
    });

    test('multiple signals can fire simultaneously', () => {
        // burn_rate + expensive_message + cost_trajectory all at once
        const signals = analyzeDelta(makeInput({
            currentDelta: 15,
            recentDeltas: [3, 3, 3],
            sessionPct: 75,
            firstTurnDelta: 2,
            turnCount: 10,
        }));
        const types = signals.map(s => s.type);
        expect(types).toContain('burn_rate');
        expect(types).toContain('expensive_message');
        expect(types).toContain('cost_trajectory');
    });
});
