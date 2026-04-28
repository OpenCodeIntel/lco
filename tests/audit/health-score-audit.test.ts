import { describe, test, expect } from 'vitest';

// Audit: lib/health-score.ts - per-model rule verification and boundary testing.
//
// After GET-28 the threshold is per-model. The audit here pins specific
// behaviors using two reference models:
//   - Sonnet 4.5 (warn=50, crit=75): 200k window, weak long-context.
//   - Opus 4.6 (warn=65, crit=85): 1M window, strong long-context.
// Plus the model-agnostic absolute floor at DEGRADING_CEIL = 90.

import {
    computeHealthScore,
    computeGrowthRate,
    DEGRADING_CEIL,
    TURN_HEALTHY_CEIL,
    TURN_DEGRADING_CEIL,
    TURN_CRITICAL_CEIL,
    FAST_GROWTH_PCT,
    type HealthInput,
} from '../../lib/health-score';

const SONNET_45 = 'claude-sonnet-4-5';
const OPUS_46 = 'claude-opus-4-6';

function input(overrides: Partial<HealthInput> = {}): HealthInput {
    return {
        contextPct: 0,
        turnCount: 0,
        growthRate: null,
        model: SONNET_45,
        isDetailHeavy: false,
        ...overrides,
    };
}

// ── Absolute floor: any model >= 90% = critical ───────────────────────────

describe('absolute critical floor', () => {
    test('exactly at DEGRADING_CEIL (90%) is critical on Sonnet 4.5', () => {
        expect(computeHealthScore(input({ contextPct: 90 })).level).toBe('critical');
    });

    test('above DEGRADING_CEIL is critical on Sonnet 4.5', () => {
        expect(computeHealthScore(input({ contextPct: 95 })).level).toBe('critical');
    });

    test('exactly at DEGRADING_CEIL is critical even on Opus 4.6 (1M)', () => {
        expect(computeHealthScore(input({ contextPct: 90, model: OPUS_46 })).level).toBe('critical');
    });

    test('per-model critical fires before the absolute floor on Opus 4.6', () => {
        // Opus 4.6 has the highest per-model crit in the table (85). At
        // 89.9% context we are below the absolute 90% floor but already
        // past Opus 4.6's per-model crit. The result is still critical;
        // this asserts the per-model rule does its job before the floor
        // ever has to step in. (No model in the table has crit > 90, so
        // no current row tests the floor in isolation; the absolute floor
        // is exercised separately by the 90% / 95% cases above.)
        expect(computeHealthScore(input({ contextPct: 89.9, model: OPUS_46 })).level).toBe('critical');
    });
});

// ── Per-model: Sonnet 4.5 thresholds (50 / 75) ────────────────────────────

describe('per-model: Sonnet 4.5 (warn=50, crit=75)', () => {
    test('crit boundary: 75% = critical', () => {
        expect(computeHealthScore(input({ contextPct: 75 })).level).toBe('critical');
    });

    test('crit boundary minus 1: 74% with low turns = degrading', () => {
        expect(computeHealthScore(input({ contextPct: 74, turnCount: 2 })).level).toBe('degrading');
    });

    test('warn boundary: 50% = degrading', () => {
        expect(computeHealthScore(input({ contextPct: 50 })).level).toBe('degrading');
    });

    test('just below warn: 49% with few turns = healthy', () => {
        expect(computeHealthScore(input({ contextPct: 49, turnCount: 3 })).level).toBe('healthy');
    });
});

// ── Per-model: Opus 4.6 thresholds (65 / 85) ──────────────────────────────

describe('per-model: Opus 4.6 (warn=65, crit=85)', () => {
    test('crit boundary: 85% = critical', () => {
        expect(computeHealthScore(input({ contextPct: 85, model: OPUS_46 })).level).toBe('critical');
    });

    test('warn boundary: 65% = degrading', () => {
        expect(computeHealthScore(input({ contextPct: 65, model: OPUS_46 })).level).toBe('degrading');
    });

    test('just below warn: 64% with few turns = healthy', () => {
        expect(computeHealthScore(input({ contextPct: 64, turnCount: 3, model: OPUS_46 })).level).toBe('healthy');
    });

    test('Opus 4.6 at 80% (degrading) where Sonnet 4.5 would be critical', () => {
        const opus = computeHealthScore(input({ contextPct: 80, model: OPUS_46, turnCount: 3 }));
        const sonnet = computeHealthScore(input({ contextPct: 80, model: SONNET_45, turnCount: 3 }));
        expect(opus.level).toBe('degrading');
        expect(sonnet.level).toBe('critical');
    });
});

// ── Turn-based escalation: approaching + many turns -> critical ─────────

describe('approaching + deep turns escalates to critical', () => {
    test('Sonnet 4.5 at 60% (approaching) with > 20 turns = critical', () => {
        const h = computeHealthScore(input({ contextPct: 60, turnCount: TURN_DEGRADING_CEIL + 2 }));
        expect(h.level).toBe('critical');
        expect(h.coaching).toMatch(/turns deep/);
    });

    test('Sonnet 4.5 at 60% (approaching) with 20 turns = degrading (boundary)', () => {
        const h = computeHealthScore(input({ contextPct: 60, turnCount: TURN_DEGRADING_CEIL }));
        expect(h.level).toBe('degrading');
    });
});

// ── Fast growth secondary signal ───────────────────────────────────────────

describe('fast growth secondary', () => {
    test('growth > 8 with context > 30 (and below warn) = degrading', () => {
        // Sonnet 4.5 warn=50; 35 with fast growth -> below warn but secondary fires.
        expect(computeHealthScore(input({ contextPct: 35, turnCount: 2, growthRate: 9 })).level).toBe('degrading');
    });

    test('growth > 8 but context <= 30 = healthy', () => {
        expect(computeHealthScore(input({ contextPct: 30, turnCount: 2, growthRate: 9 })).level).toBe('healthy');
    });

    test('growth exactly 8 = not triggered', () => {
        expect(computeHealthScore(input({ contextPct: 40, turnCount: 2, growthRate: 8 })).level).toBe('healthy');
    });

    test('remaining-messages calculation lands in coaching', () => {
        // Sonnet 4.5 warn=50, ctx=40, growth=10 -> headroom 10, ~1 message.
        const result = computeHealthScore(input({ contextPct: 40, turnCount: 2, growthRate: 10 }));
        expect(result.coaching).toMatch(/messages? until/);
    });
});

// ── Long-conversation secondary signal ─────────────────────────────────────

describe('long-conversation secondary', () => {
    test('31 turns with low context = degrading', () => {
        expect(computeHealthScore(input({ contextPct: 10, turnCount: TURN_CRITICAL_CEIL + 1 })).level).toBe('degrading');
    });

    test('30 turns with low context = healthy (below threshold)', () => {
        expect(computeHealthScore(input({ contextPct: 10, turnCount: TURN_CRITICAL_CEIL })).level).toBe('healthy');
    });
});

// ── Healthy default ────────────────────────────────────────────────────────

describe('healthy default', () => {
    test('fresh conversation = healthy with fresh-and-responsive copy', () => {
        const h = computeHealthScore(input({ contextPct: 0, turnCount: 0 }));
        expect(h.level).toBe('healthy');
        expect(h.coaching).toMatch(/fresh/i);
    });

    test('moderate context (35%) below warn shows percentage in coaching', () => {
        const h = computeHealthScore(input({ contextPct: 35, turnCount: 2 }));
        expect(h.coaching).toMatch(/35%/);
    });
});

// ── Output shape ────────────────────────────────────────────────────────────

describe('computeHealthScore: output shape', () => {
    test('contextPct is passed through unchanged', () => {
        expect(computeHealthScore(input({ contextPct: 42.5 })).contextPct).toBe(42.5);
    });

    test('label is always a non-empty string', () => {
        const inputs: HealthInput[] = [
            input({ contextPct: 0 }),
            input({ contextPct: 50, turnCount: 15 }),
            input({ contextPct: 95, turnCount: 50, growthRate: 20 }),
        ];
        for (const i of inputs) {
            const result = computeHealthScore(i);
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
        expect(computeGrowthRate([10, 20, 30])).toBeCloseTo(10, 5);
    });

    test('only counts upward deltas', () => {
        expect(computeGrowthRate([10, 5, 15])).toBeCloseTo(10, 5);
    });

    test('mixed growth and decline', () => {
        expect(computeGrowthRate([10, 20, 15, 25])).toBeCloseTo(10, 5);
    });
});

// ── Purity check ────────────────────────────────────────────────────────────

describe('purity', () => {
    test('same input produces identical output', () => {
        const i: HealthInput = input({ contextPct: 55, turnCount: 12, growthRate: 5 });
        const a = computeHealthScore(i);
        const b = computeHealthScore(i);
        expect(a).toEqual(b);
    });

    test('input object is not mutated', () => {
        const i: HealthInput = input({ contextPct: 55, turnCount: 12, growthRate: 5 });
        const frozen = { ...i };
        computeHealthScore(i);
        expect(i).toEqual(frozen);
    });
});
