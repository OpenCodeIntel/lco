import { describe, it, expect } from 'vitest';
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
        currentDelta: 3,
        recentDeltas: [2, 3, 4],
        sessionPct: 60,
        firstTurnDelta: 1.5,
        turnCount: 8,
        ...overrides,
    };
}

// ── Graceful degradation ─────────────────────────────────────────────────────

describe('graceful degradation', () => {
    it('returns empty array when all inputs are null/empty', () => {
        const signals = analyzeDelta({
            currentDelta: null,
            recentDeltas: [],
            sessionPct: 0,
            firstTurnDelta: null,
            turnCount: 0,
        });
        expect(signals).toEqual([]);
    });

    it('returns empty array when only currentDelta is provided', () => {
        const signals = analyzeDelta({
            currentDelta: 5,
            recentDeltas: [],
            sessionPct: 30,
            firstTurnDelta: null,
            turnCount: 1,
        });
        expect(signals).toEqual([]);
    });
});

// ── Burn rate prediction ─────────────────────────────────────────────────────

describe('burn_rate signal', () => {
    it('does not fire when recentDeltas < BURN_RATE_MIN_DELTAS', () => {
        const signals = analyzeDelta(makeInput({
            recentDeltas: [3, 4], // only 2, need 3
            sessionPct: 70,
        }));
        expect(signals.find(s => s.type === 'burn_rate')).toBeUndefined();
    });

    it('does not fire when sessionPct < BURN_RATE_MIN_SESSION_PCT', () => {
        const signals = analyzeDelta(makeInput({
            recentDeltas: [3, 3, 3],
            sessionPct: BURN_RATE_MIN_SESSION_PCT - 0.1,
        }));
        expect(signals.find(s => s.type === 'burn_rate')).toBeUndefined();
    });

    it('does not fire at exactly BURN_RATE_MIN_SESSION_PCT (must exceed)', () => {
        // sessionPct = 50, median delta = 3, remaining = (100-50)/3 = 16 messages
        // 16 >= 15, so no warning.
        const signals = analyzeDelta(makeInput({
            recentDeltas: [3, 3, 3],
            sessionPct: BURN_RATE_MIN_SESSION_PCT,
        }));
        // floor((100-50)/3) = 16 >= 15 -> no signal
        expect(signals.find(s => s.type === 'burn_rate')).toBeUndefined();
    });

    it('does not fire when messagesRemaining >= BURN_RATE_WARN_REMAINING', () => {
        // sessionPct = 55, median delta = 3, remaining = floor(45/3) = 15
        const signals = analyzeDelta(makeInput({
            recentDeltas: [3, 3, 3],
            sessionPct: 55,
        }));
        // floor(45/3) = 15, which is NOT less than 15
        expect(signals.find(s => s.type === 'burn_rate')).toBeUndefined();
    });

    it('fires warning when messagesRemaining is just under threshold', () => {
        // sessionPct = 58, median delta = 3, remaining = floor(42/3) = 14
        const signals = analyzeDelta(makeInput({
            recentDeltas: [3, 3, 3],
            sessionPct: 58,
        }));
        const burn = signals.find(s => s.type === 'burn_rate');
        expect(burn).toBeDefined();
        expect(burn!.severity).toBe('warning');
        expect(burn!.dismissible).toBe(true);
        expect(burn!.message).toContain('14');
    });

    it('fires critical when messagesRemaining < BURN_RATE_CRITICAL_REMAINING', () => {
        // sessionPct = 90, median delta = 3, remaining = floor(10/3) = 3
        const signals = analyzeDelta(makeInput({
            recentDeltas: [3, 3, 3],
            sessionPct: 90,
        }));
        const burn = signals.find(s => s.type === 'burn_rate');
        expect(burn).toBeDefined();
        expect(burn!.severity).toBe('critical');
        expect(burn!.dismissible).toBe(false);
    });

    it('critical message includes the computed number', () => {
        // sessionPct = 95, median delta = 2, remaining = floor(5/2) = 2
        const signals = analyzeDelta(makeInput({
            recentDeltas: [2, 2, 2],
            sessionPct: 95,
        }));
        const burn = signals.find(s => s.type === 'burn_rate');
        expect(burn).toBeDefined();
        expect(burn!.message).toContain('2');
        expect(burn!.message).toContain('session limit');
    });

    it('uses median, not mean, of recentDeltas', () => {
        // Deltas: [1, 2, 100]. Mean = 34.3, but median = 2.
        // sessionPct = 85, remaining = floor(15/2) = 7 -> warning, not critical.
        const signals = analyzeDelta(makeInput({
            recentDeltas: [1, 2, 100],
            sessionPct: 85,
        }));
        const burn = signals.find(s => s.type === 'burn_rate');
        expect(burn).toBeDefined();
        expect(burn!.severity).toBe('warning');
        expect(burn!.message).toContain('7');
    });

    it('handles singular message correctly', () => {
        // remaining = 1
        const signals = analyzeDelta(makeInput({
            recentDeltas: [10, 10, 10],
            sessionPct: 92,
        }));
        const burn = signals.find(s => s.type === 'burn_rate');
        expect(burn).toBeDefined();
        // floor(8/10) = 0 -> critical with 0 messages
        expect(burn!.message).toMatch(/~0 messages/);
    });
});

// ── Expensive message alert ──────────────────────────────────────────────────

describe('expensive_message signal', () => {
    it('does not fire when currentDelta is null', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: null,
            recentDeltas: [2, 2, 2],
        }));
        expect(signals.find(s => s.type === 'expensive_message')).toBeUndefined();
    });

    it('does not fire when recentDeltas < EXPENSIVE_MSG_MIN_DELTAS', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 10,
            recentDeltas: [2, 2], // only 2, need 3
        }));
        expect(signals.find(s => s.type === 'expensive_message')).toBeUndefined();
    });

    it('does not fire when currentDelta is exactly 2x median', () => {
        // median([2,2,2]) = 2, currentDelta = 4. 4 is NOT > 2*2. Must exceed.
        const signals = analyzeDelta(makeInput({
            currentDelta: 4,
            recentDeltas: [2, 2, 2],
        }));
        expect(signals.find(s => s.type === 'expensive_message')).toBeUndefined();
    });

    it('fires when currentDelta exceeds 2x median', () => {
        // median([2,2,2]) = 2, currentDelta = 4.1 > 4
        const signals = analyzeDelta(makeInput({
            currentDelta: 4.1,
            recentDeltas: [2, 2, 2],
        }));
        const exp = signals.find(s => s.type === 'expensive_message');
        expect(exp).toBeDefined();
        expect(exp!.severity).toBe('info');
        expect(exp!.dismissible).toBe(true);
    });

    it('message includes actual and average values with 1 decimal', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 7.3,
            recentDeltas: [2.1, 2.5, 2.3],
        }));
        const exp = signals.find(s => s.type === 'expensive_message');
        expect(exp).toBeDefined();
        expect(exp!.message).toContain('7.3%');
        // Median of [2.1, 2.3, 2.5] = 2.3
        expect(exp!.message).toContain('2.3%');
    });
});

// ── Conversation cost trajectory ─────────────────────────────────────────────

describe('cost_trajectory signal', () => {
    it('does not fire when turnCount <= TRAJECTORY_MIN_TURNS', () => {
        const signals = analyzeDelta(makeInput({
            turnCount: TRAJECTORY_MIN_TURNS,
            currentDelta: 10,
            firstTurnDelta: 2,
        }));
        expect(signals.find(s => s.type === 'cost_trajectory')).toBeUndefined();
    });

    it('does not fire when firstTurnDelta is null', () => {
        const signals = analyzeDelta(makeInput({
            turnCount: 10,
            currentDelta: 10,
            firstTurnDelta: null,
        }));
        expect(signals.find(s => s.type === 'cost_trajectory')).toBeUndefined();
    });

    it('does not fire when currentDelta is null', () => {
        const signals = analyzeDelta(makeInput({
            turnCount: 10,
            currentDelta: null,
            firstTurnDelta: 2,
        }));
        expect(signals.find(s => s.type === 'cost_trajectory')).toBeUndefined();
    });

    it('does not fire when currentDelta is exactly 2x firstTurnDelta', () => {
        const signals = analyzeDelta(makeInput({
            turnCount: 10,
            currentDelta: 4,
            firstTurnDelta: 2,
        }));
        // 4 is NOT > 2*2. Must exceed.
        expect(signals.find(s => s.type === 'cost_trajectory')).toBeUndefined();
    });

    it('fires when all conditions are met', () => {
        const signals = analyzeDelta(makeInput({
            turnCount: 10,
            currentDelta: 5,
            firstTurnDelta: 2,
        }));
        const traj = signals.find(s => s.type === 'cost_trajectory');
        expect(traj).toBeDefined();
        expect(traj!.severity).toBe('warning');
        expect(traj!.dismissible).toBe(true);
    });

    it('message includes starting and current cost', () => {
        const signals = analyzeDelta(makeInput({
            turnCount: 10,
            currentDelta: 5.2,
            firstTurnDelta: 1.8,
        }));
        const traj = signals.find(s => s.type === 'cost_trajectory');
        expect(traj).toBeDefined();
        expect(traj!.message).toContain('5.2%');
        expect(traj!.message).toContain('1.8%');
        expect(traj!.message).toContain('Starting fresh');
    });

    it('does not fire when firstTurnDelta is zero', () => {
        const signals = analyzeDelta(makeInput({
            turnCount: 10,
            currentDelta: 5,
            firstTurnDelta: 0,
        }));
        expect(signals.find(s => s.type === 'cost_trajectory')).toBeUndefined();
    });
});

// ── Signal types ─────────────────────────────────────────────────────────────

describe('signal types', () => {
    it('all signals have valid type strings', () => {
        const validTypes = new Set(['burn_rate', 'expensive_message', 'cost_trajectory']);
        const signals = analyzeDelta(makeInput({
            currentDelta: 10,
            recentDeltas: [2, 2, 2],
            sessionPct: 85,
            firstTurnDelta: 2,
            turnCount: 10,
        }));
        // Should fire all three signals with this input
        expect(signals.length).toBeGreaterThanOrEqual(2);
        for (const s of signals) {
            expect(validTypes.has(s.type)).toBe(true);
        }
    });
});

// ── Multiple signals at once ─────────────────────────────────────────────────

describe('multiple signals', () => {
    it('can fire burn_rate and cost_trajectory simultaneously', () => {
        const signals = analyzeDelta(makeInput({
            currentDelta: 9,
            recentDeltas: [3, 4, 5],
            sessionPct: 80,
            firstTurnDelta: 2,
            turnCount: 10,
        }));
        // Median = 4, remaining = floor(20/4) = 5 -> critical burn rate
        // currentDelta 9 > 2*2 firstTurnDelta -> cost_trajectory
        // currentDelta 9 > 2*4=8 median -> expensive_message
        expect(signals.find(s => s.type === 'burn_rate')).toBeDefined();
        expect(signals.find(s => s.type === 'cost_trajectory')).toBeDefined();
        expect(signals.find(s => s.type === 'expensive_message')).toBeDefined();
    });
});
