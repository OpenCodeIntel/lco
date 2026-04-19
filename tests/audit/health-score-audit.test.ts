import { describe, test, expect } from 'vitest';

// Audit: lib/health-score.ts - rule verification and boundary testing

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

// ── computeHealthScore: Rule 1 (context >= DEGRADING_CEIL = 90% = critical) ──

describe('computeHealthScore: Rule 1 (high context = critical)', () => {
    test('exactly at DEGRADING_CEIL (90%) is critical', () => {
        expect(computeHealthScore({ contextPct: 90, turnCount: 0, growthRate: null }).level).toBe('critical');
    });

    test('above DEGRADING_CEIL is critical', () => {
        expect(computeHealthScore({ contextPct: 95, turnCount: 0, growthRate: null }).level).toBe('critical');
    });

    test('just below DEGRADING_CEIL is not critical from context alone', () => {
        expect(computeHealthScore({ contextPct: 89.9, turnCount: 0, growthRate: null }).level).not.toBe('critical');
    });
});

// ── Rule 2 (high context + many turns = critical) ──────────────────────────

describe('computeHealthScore: Rule 2 (context >= 70 + turns > 20)', () => {
    test('at threshold boundary: 70% context + 21 turns = critical', () => {
        expect(computeHealthScore({ contextPct: 70, turnCount: 21, growthRate: null }).level).toBe('critical');
    });

    test('at threshold boundary: 70% context + 20 turns = degrading (not critical)', () => {
        const result = computeHealthScore({ contextPct: 70, turnCount: 20, growthRate: null });
        expect(result.level).not.toBe('critical');
    });

    test('below context threshold: 69% + 21 turns = not critical from rule 2', () => {
        const result = computeHealthScore({ contextPct: 69, turnCount: 21, growthRate: null });
        // Should be healthy or degrading from rule 5 (turns > 30), not critical
        expect(result.level).not.toBe('critical');
    });
});

// ── Rule 3 (moderate context + moderate turns = degrading) ─────────────────

describe('computeHealthScore: Rule 3 (context >= 70 + turns > 10)', () => {
    test('at threshold: 70% + 11 turns = degrading', () => {
        expect(computeHealthScore({ contextPct: 70, turnCount: 11, growthRate: null }).level).toBe('degrading');
    });

    test('below turn threshold: 70% + 10 turns = healthy (not degrading from rule 3)', () => {
        const result = computeHealthScore({ contextPct: 70, turnCount: 10, growthRate: null });
        expect(result.level).toBe('healthy');
    });
});

// ── Rule 4 (fast growth + meaningful context = degrading) ──────────────────

describe('computeHealthScore: Rule 4 (fast growth)', () => {
    test('growth > 8 with context > 30 = degrading', () => {
        expect(computeHealthScore({ contextPct: 31, turnCount: 2, growthRate: 9 }).level).toBe('degrading');
    });

    test('growth > 8 but context <= 30 = healthy', () => {
        expect(computeHealthScore({ contextPct: 30, turnCount: 2, growthRate: 9 }).level).toBe('healthy');
    });

    test('growth exactly 8 = healthy (not triggered)', () => {
        expect(computeHealthScore({ contextPct: 40, turnCount: 2, growthRate: 8 }).level).toBe('healthy');
    });

    test('remaining messages calculation in coaching', () => {
        const result = computeHealthScore({ contextPct: 40, turnCount: 2, growthRate: 10 });
        expect(result.coaching).toMatch(/~6 messages/);
    });
});

// ── Rule 5 (high turn count alone = degrading) ─────────────────────────────

describe('computeHealthScore: Rule 5 (turns > 30)', () => {
    test('31 turns with low context = degrading', () => {
        expect(computeHealthScore({ contextPct: 10, turnCount: 31, growthRate: null }).level).toBe('degrading');
    });

    test('30 turns with low context = healthy', () => {
        expect(computeHealthScore({ contextPct: 10, turnCount: 30, growthRate: null }).level).toBe('healthy');
    });
});

// ── Rule 6 (healthy default) ───────────────────────────────────────────────

describe('computeHealthScore: healthy default', () => {
    test('fresh conversation = healthy', () => {
        const result = computeHealthScore({ contextPct: 0, turnCount: 0, growthRate: null });
        expect(result.level).toBe('healthy');
        expect(result.coaching).toMatch(/fresh/i);
    });

    test('moderate context below 30% gets "plenty of room" coaching', () => {
        const result = computeHealthScore({ contextPct: 0, turnCount: 0, growthRate: null });
        expect(result.coaching).toMatch(/fresh and responsive/i);
    });

    test('context above 30% but below 50% shows percentage', () => {
        const result = computeHealthScore({ contextPct: 35, turnCount: 2, growthRate: null });
        expect(result.coaching).toMatch(/35%/);
        expect(result.coaching).toMatch(/plenty of room/i);
    });
});

// ── Output shape ────────────────────────────────────────────────────────────

describe('computeHealthScore: output shape', () => {
    test('contextPct is passed through unchanged', () => {
        expect(computeHealthScore({ contextPct: 42.5, turnCount: 0, growthRate: null }).contextPct).toBe(42.5);
    });

    test('label is always a non-empty string', () => {
        const inputs: HealthInput[] = [
            { contextPct: 0, turnCount: 0, growthRate: null },
            { contextPct: 50, turnCount: 15, growthRate: null },
            { contextPct: 95, turnCount: 50, growthRate: 20 },
        ];
        for (const input of inputs) {
            const result = computeHealthScore(input);
            expect(result.label.length).toBeGreaterThan(0);
            expect(result.coaching.length).toBeGreaterThan(0);
        }
    });
});

// ── computeGrowthRate ──────────────────────────────────────────────────────

describe('computeGrowthRate', () => {
    test('returns null for empty history', () => {
        expect(computeGrowthRate([])).toBeNull();
    });

    test('returns null for single data point', () => {
        expect(computeGrowthRate([10])).toBeNull();
    });

    test('returns null for flat history (no growth)', () => {
        expect(computeGrowthRate([10, 10, 10])).toBeNull();
    });

    test('returns null for declining history', () => {
        expect(computeGrowthRate([30, 20, 10])).toBeNull();
    });

    test('correct average for uniform growth', () => {
        // 10 -> 20 -> 30: two steps, each +10
        expect(computeGrowthRate([10, 20, 30])).toBeCloseTo(10, 5);
    });

    test('only counts upward deltas', () => {
        // 10 -> 5 -> 15: only one upward delta (+10), average = 10
        expect(computeGrowthRate([10, 5, 15])).toBeCloseTo(10, 5);
    });

    test('mixed growth and decline', () => {
        // 10 -> 20 -> 15 -> 25: upward deltas: +10, +10. Average = 10
        expect(computeGrowthRate([10, 20, 15, 25])).toBeCloseTo(10, 5);
    });
});

// ── Purity check ────────────────────────────────────────────────────────────

describe('purity', () => {
    test('same input produces identical output', () => {
        const input: HealthInput = { contextPct: 55, turnCount: 12, growthRate: 5 };
        const a = computeHealthScore(input);
        const b = computeHealthScore(input);
        expect(a).toEqual(b);
    });

    test('input object is not mutated', () => {
        const input: HealthInput = { contextPct: 55, turnCount: 12, growthRate: 5 };
        const frozen = { ...input };
        computeHealthScore(input);
        expect(input).toEqual(frozen);
    });
});
