// tests/unit/health-score.test.ts
// Tests for the conversation health score module.
//
// Health score is now per-model: thresholds come from
// lib/context-rot-thresholds.ts. Tests pick a specific model so the
// threshold under test is unambiguous. Sonnet 4.5 (warn=50, crit=75) is
// the workhorse fixture because its 200k window matches the historical
// test assumptions and it carries a verified Anthropic MRCR figure.

import { describe, it, expect } from 'vitest';
import {
    computeHealthScore,
    computeGrowthRate,
    DEGRADING_CEIL,
    HEALTHY_CEIL,
    TURN_HEALTHY_CEIL,
    TURN_DEGRADING_CEIL,
    TURN_CRITICAL_CEIL,
    FAST_GROWTH_PCT,
    type HealthInput,
} from '../../lib/health-score';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Sonnet 4.5 is the rot exemplar (warn=50, crit=75) and matches the
// 200k-window assumptions in the legacy tests. Most cases use it.
const SONNET_45 = 'claude-sonnet-4-5';

// Opus 4.6 is the well-behaved 1M model (warn=65, crit=85). Used for
// cases that need to verify model-specific differentiation.
const OPUS_46 = 'claude-opus-4-6';

// Sonnet 4.6 (warn=60, crit=80, compaction-aware). Used for copy
// assertions about server-side compaction.
const SONNET_46 = 'claude-sonnet-4-6';

function input(overrides: Partial<HealthInput> = {}): HealthInput {
    return {
        contextPct: 10,
        turnCount: 3,
        growthRate: null,
        model: SONNET_45,
        isDetailHeavy: false,
        ...overrides,
    };
}

// ── Critical conditions ───────────────────────────────────────────────────────

describe('critical health', () => {
    it('returns critical at the absolute floor (90%) regardless of model', () => {
        const h = computeHealthScore(input({ model: OPUS_46, contextPct: DEGRADING_CEIL }));
        expect(h.level).toBe('critical');
    });

    it('returns critical at 100% context', () => {
        const h = computeHealthScore(input({ contextPct: 100 }));
        expect(h.level).toBe('critical');
    });

    it('returns critical at the per-model critical threshold', () => {
        // Sonnet 4.5 crit = 75
        const h = computeHealthScore(input({ contextPct: 75 }));
        expect(h.level).toBe('critical');
    });

    it('Opus 4.6 stays healthy at 75% where Sonnet 4.5 would be critical', () => {
        const sonnet = computeHealthScore(input({ model: SONNET_45, contextPct: 75 }));
        const opus = computeHealthScore(input({ model: OPUS_46, contextPct: 75 }));
        expect(sonnet.level).toBe('critical');
        // 75 is between Opus warn (65) and Opus crit (85) -> degrading.
        expect(opus.level).toBe('degrading');
    });

    it('promotes to critical when in approaching zone with deep turn count', () => {
        // Sonnet 4.5 approaching at 60% + 25 turns -> rule 2 promotes to critical.
        const h = computeHealthScore(input({ contextPct: 60, turnCount: TURN_DEGRADING_CEIL + 5 }));
        expect(h.level).toBe('critical');
        expect(h.coaching).toMatch(/turns deep/);
    });
});

// ── Degrading conditions ──────────────────────────────────────────────────────

describe('degrading health', () => {
    it('returns degrading at the per-model warn threshold', () => {
        // Sonnet 4.5 warn = 50
        const h = computeHealthScore(input({ contextPct: 50 }));
        expect(h.level).toBe('degrading');
    });

    it('returns degrading just below the per-model critical threshold', () => {
        const h = computeHealthScore(input({ contextPct: 70 }));
        expect(h.level).toBe('degrading');
    });

    it('returns degrading when growth rate is fast and context > 30%', () => {
        // 35% on Sonnet 4.5 is below warn=50 -> primary says healthy.
        // Fast growth secondary kicks in.
        const h = computeHealthScore(input({
            contextPct: 35,
            turnCount: 5,
            growthRate: FAST_GROWTH_PCT + 1,
        }));
        expect(h.level).toBe('degrading');
        expect(h.coaching).toMatch(/messages? until/);
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

    it('uses singular "message" when only 1 message remaining to warn', () => {
        // Sonnet 4.5 warn=50, contextPct=45, growth=15 -> headroom 5, 5/15 -> 0
        // Pick numbers so headroom/growth rounds to 1.
        // contextPct=42, growth=8.1 -> just over FAST_GROWTH_PCT, headroom 8, ~1 message
        const h = computeHealthScore(input({
            contextPct: 42,
            turnCount: 3,
            growthRate: 8.1,
        }));
        expect(h.level).toBe('degrading');
        expect(h.coaching).toMatch(/1 message until/);
    });
});

// ── Healthy conditions ────────────────────────────────────────────────────────

describe('healthy', () => {
    it('returns healthy for fresh conversation', () => {
        const h = computeHealthScore(input({ contextPct: 5, turnCount: 2 }));
        expect(h.level).toBe('healthy');
        expect(h.label).toBe('Healthy');
    });

    it('returns healthy below the per-model warn threshold with few turns', () => {
        // Sonnet 4.5 warn = 50; 49 with 5 turns is healthy.
        const h = computeHealthScore(input({ contextPct: 49, turnCount: 5 }));
        expect(h.level).toBe('healthy');
    });

    it('shows "fresh and responsive" for low context', () => {
        const h = computeHealthScore(input({ contextPct: 10 }));
        expect(h.coaching).toMatch(/fresh and responsive/i);
    });

    it('shows context percentage and model label for moderate usage', () => {
        const h = computeHealthScore(input({ contextPct: 35, turnCount: 5 }));
        expect(h.coaching).toMatch(/35%/);
        expect(h.coaching).toMatch(/Sonnet 4\.5/);
    });
});

// ── Detail-heavy adjustment ──────────────────────────────────────────────────

describe('detail-heavy adjustment', () => {
    it('shifts the warn threshold earlier on Opus 4.6', () => {
        // Opus 4.6 warn = 65 normally, 50 under detail-heavy.
        // 55% is healthy on a normal turn but degrading on a precision turn.
        const normal = computeHealthScore(input({ model: OPUS_46, contextPct: 55, isDetailHeavy: false }));
        const heavy = computeHealthScore(input({ model: OPUS_46, contextPct: 55, isDetailHeavy: true }));
        expect(normal.level).toBe('healthy');
        expect(heavy.level).toBe('degrading');
    });

    it('shifts the critical threshold earlier on Sonnet 4.5', () => {
        // Sonnet 4.5 crit = 75 normally, 60 under detail-heavy.
        // 62% is degrading on a normal turn but critical on a precision turn.
        const normal = computeHealthScore(input({ model: SONNET_45, contextPct: 62, isDetailHeavy: false }));
        const heavy = computeHealthScore(input({ model: SONNET_45, contextPct: 62, isDetailHeavy: true }));
        expect(normal.level).toBe('degrading');
        expect(heavy.level).toBe('critical');
    });
});

// ── Coaching copy ────────────────────────────────────────────────────────────

describe('coaching copy: model-aware and evidence-grounded', () => {
    it('cites Sonnet 4.5 MRCR figure in approaching-zone copy', () => {
        const h = computeHealthScore(input({ model: SONNET_45, contextPct: 55 }));
        expect(h.level).toBe('degrading');
        expect(h.coaching).toMatch(/Sonnet 4\.5/);
        expect(h.coaching).toMatch(/18\.5%/);
        expect(h.coaching).toMatch(/MRCR/);
    });

    it('cites Opus 4.6 MRCR figure in approaching-zone copy', () => {
        const h = computeHealthScore(input({ model: OPUS_46, contextPct: 70 }));
        expect(h.level).toBe('degrading');
        expect(h.coaching).toMatch(/Opus 4\.6/);
        expect(h.coaching).toMatch(/76%/);
    });

    it('mentions compaction for Sonnet 4.6 (compaction-aware)', () => {
        const h = computeHealthScore(input({ model: SONNET_46, contextPct: 65 }));
        expect(h.coaching).toMatch(/compaction/i);
    });

    it('does not mention compaction for Sonnet 4.5 (no compaction)', () => {
        const h = computeHealthScore(input({ model: SONNET_45, contextPct: 55 }));
        expect(h.coaching).not.toMatch(/compaction/i);
    });

    it('mentions Projects in critical zone for Sonnet 4.5', () => {
        const h = computeHealthScore(input({ model: SONNET_45, contextPct: 80 }));
        expect(h.coaching).toMatch(/Projects/);
    });

    it('never includes a /compact instruction', () => {
        for (const model of [SONNET_45, SONNET_46, OPUS_46]) {
            for (const pct of [10, 50, 70, 85, 95]) {
                const h = computeHealthScore(input({ model, contextPct: pct, turnCount: 5 }));
                expect(h.coaching).not.toMatch(/\/compact/);
            }
        }
    });
});

// ── Boundary conditions ───────────────────────────────────────────────────────

describe('boundaries', () => {
    it('Sonnet 4.5 at exactly 50% with few turns = degrading (warn boundary)', () => {
        const h = computeHealthScore(input({ contextPct: 50, turnCount: 5 }));
        expect(h.level).toBe('degrading');
    });

    it('Sonnet 4.5 just below warn (49%) with few turns = healthy', () => {
        const h = computeHealthScore(input({ contextPct: 49, turnCount: 5 }));
        expect(h.level).toBe('healthy');
    });

    it('absolute floor (90%) overrides per-model regardless of model', () => {
        const h = computeHealthScore(input({ model: OPUS_46, contextPct: DEGRADING_CEIL, turnCount: 1 }));
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
});

// ── Rule priority ─────────────────────────────────────────────────────────────

describe('rule priority', () => {
    it('absolute critical overrides turn-based degrading', () => {
        const h = computeHealthScore(input({
            contextPct: DEGRADING_CEIL,
            turnCount: TURN_HEALTHY_CEIL + 1,
        }));
        expect(h.level).toBe('critical');
    });

    it('per-model critical wins over fast-growth secondary', () => {
        // Sonnet 4.5 at 80% is in-rot. Fast growth would only have made it
        // degrading. Verify the more severe primary classifier wins.
        const h = computeHealthScore(input({
            contextPct: 80,
            turnCount: 3,
            growthRate: FAST_GROWTH_PCT + 5,
        }));
        expect(h.level).toBe('critical');
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

// ── Legacy constants still exported (back-compat) ─────────────────────────────

describe('legacy exports', () => {
    it('exports HEALTHY_CEIL = 70 (legacy default warn)', () => {
        expect(HEALTHY_CEIL).toBe(70);
    });

    it('exports DEGRADING_CEIL = 90 (absolute critical floor)', () => {
        expect(DEGRADING_CEIL).toBe(90);
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
        expect(computeGrowthRate([10, 20, 30])).toBe(10);
    });

    it('ignores downward steps', () => {
        expect(computeGrowthRate([10, 20, 15, 25])).toBe(10);
    });

    it('handles mixed growth rates', () => {
        expect(computeGrowthRate([0, 5, 8, 20])).toBeCloseTo(6.67, 1);
    });
});
