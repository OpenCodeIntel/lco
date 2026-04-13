import { describe, test, expect } from 'vitest';

// Audit: lib/pre-submit.ts - draft cost prediction

import {
    computePreSubmitEstimate,
    MIN_DRAFT_CHARS,
    MODEL_COMPARE_THRESHOLD_PCT,
    WARNING_ZONE_PCT,
    type PreSubmitInput,
} from '../../lib/pre-submit';

function makeInput(overrides: Partial<PreSubmitInput> = {}): PreSubmitInput {
    return {
        draftCharCount: 100,
        model: 'claude-sonnet-4-6',
        pctPerInputToken: null,
        currentSessionPct: 10,
        ...overrides,
    };
}

// ── Null returns ───────────────────────────────────────────────────────────

describe('null returns (below threshold)', () => {
    test('returns null for draft below MIN_DRAFT_CHARS', () => {
        expect(computePreSubmitEstimate(makeInput({ draftCharCount: 19 }))).toBeNull();
    });

    test('returns null for zero chars', () => {
        expect(computePreSubmitEstimate(makeInput({ draftCharCount: 0 }))).toBeNull();
    });

    test('returns estimate at exactly MIN_DRAFT_CHARS', () => {
        expect(computePreSubmitEstimate(makeInput({ draftCharCount: 20 }))).not.toBeNull();
    });
});

// ── Token estimation ───────────────────────────────────────────────────────

describe('token estimation', () => {
    test('estimated tokens = round(chars / 4)', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 100 }))!;
        expect(result.estimatedTokens).toBe(25);
    });

    test('rounding for non-divisible counts', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 101 }))!;
        expect(result.estimatedTokens).toBe(25); // Math.round(25.25) = 25
    });

    test('large draft', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 10000 }))!;
        expect(result.estimatedTokens).toBe(2500);
    });
});

// ── Session % prediction ───────────────────────────────────────────────────

describe('session % prediction', () => {
    test('null when pctPerInputToken is null', () => {
        const result = computePreSubmitEstimate(makeInput({ pctPerInputToken: null }))!;
        expect(result.estimatedSessionPct).toBeNull();
        expect(result.projectedTotalPct).toBeNull();
    });

    test('null when model not in pctPerInputToken', () => {
        const result = computePreSubmitEstimate(makeInput({
            pctPerInputToken: { 'claude-opus-4-6': 0.01 },
            model: 'claude-sonnet-4-6',
        }))!;
        expect(result.estimatedSessionPct).toBeNull();
    });

    test('correct estimation with known rate', () => {
        // 100 chars = 25 tokens, rate = 0.1 per token -> 2.5%
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 100,
            pctPerInputToken: { 'claude-sonnet-4-6': 0.1 },
            model: 'claude-sonnet-4-6',
            currentSessionPct: 10,
        }))!;
        expect(result.estimatedSessionPct).toBeCloseTo(2.5, 5);
        expect(result.projectedTotalPct).toBeCloseTo(12.5, 5);
    });

    test('skips rate of 0', () => {
        const result = computePreSubmitEstimate(makeInput({
            pctPerInputToken: { 'claude-sonnet-4-6': 0 },
        }))!;
        expect(result.estimatedSessionPct).toBeNull();
    });
});

// ── Model comparisons ──────────────────────────────────────────────────────

describe('model comparisons', () => {
    test('empty when estimated % <= threshold', () => {
        // 100 chars = 25 tokens, rate = 0.1 -> 2.5% < 5%
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 100,
            pctPerInputToken: { 'claude-sonnet-4-6': 0.1, 'claude-haiku-4-5': 0.02 },
        }))!;
        expect(result.modelComparisons).toHaveLength(0);
    });

    test('populated when estimated % > threshold', () => {
        // 1000 chars = 250 tokens, rate = 0.1 -> 25% > 5%
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 1000,
            pctPerInputToken: {
                'claude-sonnet-4-6': 0.1,
                'claude-haiku-4-5': 0.02,
                'claude-opus-4-6': 0.2,
            },
        }))!;
        expect(result.modelComparisons.length).toBeGreaterThan(0);
        // Should be sorted ascending by estimatedPct
        for (let i = 1; i < result.modelComparisons.length; i++) {
            expect(result.modelComparisons[i].estimatedPct).toBeGreaterThanOrEqual(
                result.modelComparisons[i - 1].estimatedPct,
            );
        }
    });

    test('excludes models with zero rate', () => {
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 1000,
            pctPerInputToken: {
                'claude-sonnet-4-6': 0.1,
                'claude-haiku-4-5': 0,
            },
        }))!;
        const models = result.modelComparisons.map(c => c.model);
        expect(models).not.toContain('claude-haiku-4-5');
    });

    test('excludes unrecognized models (no tier)', () => {
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 1000,
            pctPerInputToken: {
                'claude-sonnet-4-6': 0.1,
                'gpt-4o': 0.05,
            },
        }))!;
        const models = result.modelComparisons.map(c => c.model);
        expect(models).not.toContain('gpt-4o');
    });
});

// ── Warning zone ───────────────────────────────────────────────────────────

describe('warning zone', () => {
    test('warning when projected total >= 90%', () => {
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 1000,
            pctPerInputToken: { 'claude-sonnet-4-6': 0.1 },
            currentSessionPct: 70,
        }))!;
        // 250 tokens * 0.1 = 25%. 70 + 25 = 95% >= 90%
        expect(result.warning).not.toBeNull();
        expect(result.warning).toMatch(/95%/);
    });

    test('no warning when projected total < 90%', () => {
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 100,
            pctPerInputToken: { 'claude-sonnet-4-6': 0.1 },
            currentSessionPct: 10,
        }))!;
        expect(result.warning).toBeNull();
    });

    test('no warning when session prediction unavailable', () => {
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 1000,
            pctPerInputToken: null,
            currentSessionPct: 85,
        }))!;
        expect(result.warning).toBeNull();
    });
});
