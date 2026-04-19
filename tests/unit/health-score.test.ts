// tests/unit/health-score.test.ts
// Tests for the conversation health score module.

import { describe, it, expect } from 'vitest';
import {
    computeHealthScore,
    computeGrowthRate,
    HEALTHY_CEIL,
    DEGRADING_CEIL,
    TURN_HEALTHY_CEIL,
    TURN_DEGRADING_CEIL,
    TURN_CRITICAL_CEIL,
    FAST_GROWTH_PCT,
    type HealthInput,
} from '../../lib/health-score';

function input(overrides: Partial<HealthInput> = {}): HealthInput {
    return { contextPct: 10, turnCount: 3, growthRate: null, ...overrides };
}

// ── Critical conditions ───────────────────────────────────────────────────────

describe('critical health', () => {
    it('returns critical when context >= DEGRADING_CEIL', () => {
        const h = computeHealthScore(input({ contextPct: DEGRADING_CEIL }));
        expect(h.level).toBe('critical');
    });

    it('returns critical at 100% context', () => {
        const h = computeHealthScore(input({ contextPct: 100 }));
        expect(h.level).toBe('critical');
    });

    it('returns critical when context >= HEALTHY_CEIL and turns > TURN_DEGRADING_CEIL', () => {
        const h = computeHealthScore(input({
            contextPct: HEALTHY_CEIL,
            turnCount: TURN_DEGRADING_CEIL + 1,
        }));
        expect(h.level).toBe('critical');
    });

    it('includes turn count in coaching when critical from turns', () => {
        const h = computeHealthScore(input({
            contextPct: 75,
            turnCount: 25,
        }));
        expect(h.coaching).toMatch(/25 turns deep/);
    });
});

// ── Degrading conditions ──────────────────────────────────────────────────────

describe('degrading health', () => {
    it('returns degrading when context >= HEALTHY_CEIL and turns > TURN_HEALTHY_CEIL', () => {
        const h = computeHealthScore(input({
            contextPct: HEALTHY_CEIL,
            turnCount: TURN_HEALTHY_CEIL + 1,
        }));
        expect(h.level).toBe('degrading');
    });

    it('returns degrading at context just below DEGRADING_CEIL with moderate turns', () => {
        const h = computeHealthScore(input({
            contextPct: DEGRADING_CEIL - 1,
            turnCount: TURN_HEALTHY_CEIL + 5,
        }));
        expect(h.level).toBe('degrading');
    });

    it('returns degrading when growth rate is fast and context > 30%', () => {
        const h = computeHealthScore(input({
            contextPct: 35,
            turnCount: 5,
            growthRate: FAST_GROWTH_PCT + 1,
        }));
        expect(h.level).toBe('degrading');
        expect(h.coaching).toMatch(/~\d+ message/);
    });

    it('does not trigger growth-rate degrading when context <= 30%', () => {
        const h = computeHealthScore(input({
            contextPct: 25,
            turnCount: 3,
            growthRate: FAST_GROWTH_PCT + 5,
        }));
        expect(h.level).toBe('healthy');
    });

    it('returns degrading for very long conversations even with low context', () => {
        const h = computeHealthScore(input({
            contextPct: 20,
            turnCount: TURN_CRITICAL_CEIL + 1,
        }));
        expect(h.level).toBe('degrading');
    });

    it('uses singular "message" when only 1 message remaining', () => {
        // contextPct=80, growthRate=15: (100-80)/15 = 1.33, rounds to 1 → "~1 message"
        // Rule 4 fires: growthRate(15) > FAST_GROWTH_PCT(8) && contextPct(80) > 30
        const h = computeHealthScore(input({
            contextPct: 80,
            turnCount: 3,
            growthRate: 15,
        }));
        expect(h.level).toBe('degrading');
        expect(h.coaching).toMatch(/~1 message until context limit/);
    });
});

// ── Healthy conditions ────────────────────────────────────────────────────────

describe('healthy', () => {
    it('returns healthy for fresh conversation', () => {
        const h = computeHealthScore(input({ contextPct: 5, turnCount: 2 }));
        expect(h.level).toBe('healthy');
        expect(h.label).toBe('Healthy');
    });

    it('returns healthy at context just below HEALTHY_CEIL with few turns', () => {
        const h = computeHealthScore(input({
            contextPct: HEALTHY_CEIL - 1,
            turnCount: TURN_HEALTHY_CEIL,
        }));
        expect(h.level).toBe('healthy');
    });

    it('shows "fresh and responsive" for low context', () => {
        const h = computeHealthScore(input({ contextPct: 10 }));
        expect(h.coaching).toMatch(/fresh and responsive/);
    });

    it('shows context percentage for moderate usage', () => {
        const h = computeHealthScore(input({ contextPct: 35, turnCount: 5 }));
        expect(h.coaching).toMatch(/35% context used/);
    });

    it('returns healthy when turns are below threshold even with moderate context', () => {
        const h = computeHealthScore(input({
            contextPct: 45,
            turnCount: TURN_HEALTHY_CEIL,
        }));
        expect(h.level).toBe('healthy');
    });
});

// ── Boundary conditions ───────────────────────────────────────────────────────

describe('boundaries', () => {
    it('context at exactly HEALTHY_CEIL with exactly TURN_HEALTHY_CEIL turns = healthy', () => {
        const h = computeHealthScore(input({
            contextPct: HEALTHY_CEIL,
            turnCount: TURN_HEALTHY_CEIL,
        }));
        // HEALTHY_CEIL with turnCount = TURN_HEALTHY_CEIL (not > TURN_HEALTHY_CEIL): healthy
        expect(h.level).toBe('healthy');
    });

    it('context at exactly HEALTHY_CEIL with TURN_HEALTHY_CEIL + 1 = degrading', () => {
        const h = computeHealthScore(input({
            contextPct: HEALTHY_CEIL,
            turnCount: TURN_HEALTHY_CEIL + 1,
        }));
        expect(h.level).toBe('degrading');
    });

    it('context at exactly DEGRADING_CEIL = critical regardless of turns', () => {
        const h = computeHealthScore(input({ contextPct: DEGRADING_CEIL, turnCount: 1 }));
        expect(h.level).toBe('critical');
    });

    it('growth rate at exactly FAST_GROWTH_PCT does not trigger degrading', () => {
        const h = computeHealthScore(input({
            contextPct: 40,
            turnCount: 5,
            growthRate: FAST_GROWTH_PCT,
        }));
        expect(h.level).toBe('healthy');
    });

    it('growth rate just above FAST_GROWTH_PCT with context > 30 triggers degrading', () => {
        const h = computeHealthScore(input({
            contextPct: 35,
            turnCount: 5,
            growthRate: FAST_GROWTH_PCT + 0.1,
        }));
        expect(h.level).toBe('degrading');
    });
});

// ── Rule priority ─────────────────────────────────────────────────────────────

describe('rule priority', () => {
    it('context-based critical overrides turn-based degrading', () => {
        const h = computeHealthScore(input({
            contextPct: DEGRADING_CEIL,
            turnCount: TURN_HEALTHY_CEIL + 1,
        }));
        expect(h.level).toBe('critical');
        expect(h.coaching).toMatch(/nearly full/);
    });

    it('turn+context critical overrides growth-rate degrading', () => {
        const h = computeHealthScore(input({
            contextPct: 75,
            turnCount: TURN_DEGRADING_CEIL + 1,
            growthRate: FAST_GROWTH_PCT + 5,
        }));
        expect(h.level).toBe('critical');
        expect(h.coaching).toMatch(/turns deep/);
    });
});

// ── HealthScore shape ─────────────────────────────────────────────────────────

describe('HealthScore shape', () => {
    it('always includes contextPct passthrough', () => {
        const h = computeHealthScore(input({ contextPct: 42 }));
        expect(h.contextPct).toBe(42);
    });

    it('always has non-empty label and coaching', () => {
        for (const pct of [5, 55, 85]) {
            const h = computeHealthScore(input({ contextPct: pct, turnCount: 15 }));
            expect(h.label.length).toBeGreaterThan(0);
            expect(h.coaching.length).toBeGreaterThan(0);
        }
    });
});

// ── computeGrowthRate ─────────────────────────────────────────────────────────

describe('computeGrowthRate', () => {
    it('returns null for empty history', () => {
        expect(computeGrowthRate([])).toBeNull();
    });

    it('returns null for single entry', () => {
        expect(computeGrowthRate([50])).toBeNull();
    });

    it('returns null when history only decreases', () => {
        expect(computeGrowthRate([50, 40, 30])).toBeNull();
    });

    it('computes average upward growth', () => {
        // [10, 20, 30]: two upward steps of 10 each
        expect(computeGrowthRate([10, 20, 30])).toBe(10);
    });

    it('ignores downward steps', () => {
        // [10, 20, 15, 25]: upward steps are 10 and 10, avg = 10
        expect(computeGrowthRate([10, 20, 15, 25])).toBe(10);
    });

    it('handles mixed growth rates', () => {
        // [0, 5, 8, 20]: upward steps are 5, 3, 12. avg = 20/3 ≈ 6.67
        expect(computeGrowthRate([0, 5, 8, 20])).toBeCloseTo(6.67, 1);
    });
});
