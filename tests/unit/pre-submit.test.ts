import { describe, it, expect } from 'vitest';
import {
    computePreSubmitEstimate,
    MIN_DRAFT_CHARS,
    MODEL_COMPARE_THRESHOLD_PCT,
    WARNING_ZONE_PCT,
    type PreSubmitInput,
} from '../../lib/pre-submit';

function makeInput(overrides: Partial<PreSubmitInput> = {}): PreSubmitInput {
    return {
        draftCharCount: 200,
        model: 'claude-sonnet-4-6',
        pctPerInputToken: {
            'claude-sonnet-4-6': 0.01,   // 1% per 100 input tokens
            'claude-opus-4-6': 0.03,     // 3% per 100 input tokens
            'claude-haiku-4-5': 0.002,   // 0.2% per 100 input tokens
        },
        currentSessionPct: 40,
        ...overrides,
    };
}

// ── Threshold and null handling ──────────────────────────────────────────────

describe('threshold and null handling', () => {
    it('returns null when draftCharCount < MIN_DRAFT_CHARS', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: MIN_DRAFT_CHARS - 1 }));
        expect(result).toBeNull();
    });

    it('returns null for zero-length draft', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 0 }));
        expect(result).toBeNull();
    });

    it('returns estimate at exactly MIN_DRAFT_CHARS', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: MIN_DRAFT_CHARS }));
        expect(result).not.toBeNull();
    });

    it('returns null estimatedSessionPct when pctPerInputToken is null', () => {
        const result = computePreSubmitEstimate(makeInput({ pctPerInputToken: null }));
        expect(result).not.toBeNull();
        expect(result!.estimatedTokens).toBe(50); // 200 / 4
        expect(result!.estimatedSessionPct).toBeNull();
    });

    it('returns null estimatedSessionPct when model missing from pctPerInputToken', () => {
        const result = computePreSubmitEstimate(makeInput({
            model: 'unknown-model',
            pctPerInputToken: { 'claude-sonnet-4-6': 0.01 },
        }));
        expect(result).not.toBeNull();
        expect(result!.estimatedSessionPct).toBeNull();
    });
});

// ── Token estimation ─────────────────────────────────────────────────────────

describe('token estimation', () => {
    it('computes estimatedTokens as chars / 4', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 400 }));
        expect(result!.estimatedTokens).toBe(100);
    });

    it('rounds to nearest integer', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 201 }));
        expect(result!.estimatedTokens).toBe(50); // 201/4 = 50.25 -> 50
    });

    it('large draft returns proportionally large estimate', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 4000 }));
        expect(result!.estimatedTokens).toBe(1000);
    });
});

// ── Session % estimation ─────────────────────────────────────────────────────

describe('session % estimation', () => {
    it('computes estimatedSessionPct from pctPerInputToken', () => {
        // 200 chars -> 50 tokens, rate = 0.01 per token -> 0.5%
        const result = computePreSubmitEstimate(makeInput());
        expect(result!.estimatedSessionPct).toBeCloseTo(0.5, 2);
    });

    it('computes projectedTotalPct = currentSessionPct + estimatedSessionPct', () => {
        const result = computePreSubmitEstimate(makeInput({ currentSessionPct: 40 }));
        // 40% + 0.5% = 40.5%
        expect(result!.projectedTotalPct).toBeCloseTo(40.5, 2);
    });

    it('projectedTotalPct is null when estimatedSessionPct is null', () => {
        const result = computePreSubmitEstimate(makeInput({ pctPerInputToken: null }));
        expect(result!.projectedTotalPct).toBeNull();
    });
});

// ── Model comparisons ────────────────────────────────────────────────────────

describe('model comparisons', () => {
    it('empty when estimatedSessionPct <= MODEL_COMPARE_THRESHOLD_PCT', () => {
        // Small draft: 200 chars -> 50 tokens * 0.01 = 0.5% (below 5%)
        const result = computePreSubmitEstimate(makeInput());
        expect(result!.modelComparisons).toHaveLength(0);
    });

    it('populated when estimatedSessionPct > MODEL_COMPARE_THRESHOLD_PCT', () => {
        // Large draft: 4000 chars -> 1000 tokens * 0.01 = 10% (above 5%)
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 4000 }));
        expect(result!.modelComparisons.length).toBeGreaterThan(0);
    });

    it('sorted ascending by estimatedPct', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 4000 }));
        const pcts = result!.modelComparisons.map(c => c.estimatedPct);
        for (let i = 1; i < pcts.length; i++) {
            expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
        }
    });

    it('includes model labels from classifyModelTier', () => {
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 4000 }));
        const labels = result!.modelComparisons.map(c => c.label);
        expect(labels).toContain('Haiku');
        expect(labels).toContain('Sonnet');
        expect(labels).toContain('Opus');
    });

    it('computes correct per-model estimates', () => {
        // 4000 chars -> 1000 tokens
        // Haiku: 1000 * 0.002 = 2%, Sonnet: 1000 * 0.01 = 10%, Opus: 1000 * 0.03 = 30%
        const result = computePreSubmitEstimate(makeInput({ draftCharCount: 4000 }));
        const haiku = result!.modelComparisons.find(c => c.label === 'Haiku');
        const sonnet = result!.modelComparisons.find(c => c.label === 'Sonnet');
        const opus = result!.modelComparisons.find(c => c.label === 'Opus');
        expect(haiku!.estimatedPct).toBeCloseTo(2, 1);
        expect(sonnet!.estimatedPct).toBeCloseTo(10, 1);
        expect(opus!.estimatedPct).toBeCloseTo(30, 1);
    });
});

// ── Warning ──────────────────────────────────────────────────────────────────

describe('warning', () => {
    it('no warning when projectedTotalPct < WARNING_ZONE_PCT', () => {
        const result = computePreSubmitEstimate(makeInput({ currentSessionPct: 40 }));
        expect(result!.warning).toBeNull();
    });

    it('warning when projectedTotalPct >= WARNING_ZONE_PCT', () => {
        // 4000 chars -> 1000 tokens * 0.01 = 10%, currentSession = 85%
        // projected = 95% >= 90%
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 4000,
            currentSessionPct: 85,
        }));
        expect(result!.warning).not.toBeNull();
        expect(result!.warning).toContain('95%');
    });

    it('warning at exactly WARNING_ZONE_PCT', () => {
        // Need projected = exactly 90%: currentSession = 80%, draft cost = 10%
        const result = computePreSubmitEstimate(makeInput({
            draftCharCount: 4000,
            currentSessionPct: 80,
        }));
        // 1000 tokens * 0.01 = 10%, projected = 90%
        expect(result!.warning).not.toBeNull();
    });

    it('no warning when estimatedSessionPct is null', () => {
        const result = computePreSubmitEstimate(makeInput({
            pctPerInputToken: null,
            currentSessionPct: 95,
        }));
        expect(result!.warning).toBeNull();
    });
});
