import { describe, test, expect } from 'vitest';

// Audit: lib/pricing.ts - cost calculation accuracy, boundary behavior, floating point

import { lookupModel, calculateCost, getContextWindowSize } from '../../lib/pricing';

// ── lookupModel ─────────────────────────────────────────────────────────────

describe('lookupModel', () => {
    test('returns pricing for all known models', () => {
        const models = [
            'claude-opus-4-6-20250514', 'claude-opus-4-6',
            'claude-sonnet-4-6-20250514', 'claude-sonnet-4-6',
            'claude-haiku-4-5-20251001', 'claude-haiku-4-5',
        ];
        for (const m of models) {
            const result = lookupModel(m);
            expect(result).not.toBeNull();
            expect(result!.inputCostPerToken).toBeGreaterThan(0);
            expect(result!.outputCostPerToken).toBeGreaterThan(0);
            expect(result!.contextWindow).toBeGreaterThan(0);
        }
    });

    test('returns null for unknown model', () => {
        expect(lookupModel('gpt-4o')).toBeNull();
        expect(lookupModel('claude-unknown-99')).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(lookupModel('')).toBeNull();
    });

    // Verify published pricing: Opus $5/$25 per M, Sonnet $3/$15, Haiku $1/$5
    test('Opus pricing matches published rates ($5/$25 per million)', () => {
        const p = lookupModel('claude-opus-4-6')!;
        expect(p.inputCostPerToken * 1_000_000).toBeCloseTo(5, 5);
        expect(p.outputCostPerToken * 1_000_000).toBeCloseTo(25, 5);
    });

    test('Sonnet pricing matches published rates ($3/$15 per million)', () => {
        const p = lookupModel('claude-sonnet-4-6')!;
        expect(p.inputCostPerToken * 1_000_000).toBeCloseTo(3, 5);
        expect(p.outputCostPerToken * 1_000_000).toBeCloseTo(15, 5);
    });

    test('Haiku pricing matches published rates ($1/$5 per million)', () => {
        const p = lookupModel('claude-haiku-4-5')!;
        expect(p.inputCostPerToken * 1_000_000).toBeCloseTo(1, 5);
        expect(p.outputCostPerToken * 1_000_000).toBeCloseTo(5, 5);
    });

    test('all known models have 200k context window', () => {
        const models = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
        for (const m of models) {
            expect(lookupModel(m)!.contextWindow).toBe(200_000);
        }
    });
});

// ── calculateCost ───────────────────────────────────────────────────────────

describe('calculateCost', () => {
    test('returns null for unknown model', () => {
        expect(calculateCost(1000, 500, 'unknown-model')).toBeNull();
    });

    test('returns null for negative input tokens', () => {
        expect(calculateCost(-1, 500, 'claude-sonnet-4-6')).toBeNull();
    });

    test('returns null for negative output tokens', () => {
        expect(calculateCost(1000, -1, 'claude-sonnet-4-6')).toBeNull();
    });

    test('zero tokens = zero cost', () => {
        expect(calculateCost(0, 0, 'claude-sonnet-4-6')).toBe(0);
    });

    test('correct cost for 1M input tokens on Sonnet', () => {
        const cost = calculateCost(1_000_000, 0, 'claude-sonnet-4-6');
        expect(cost).toBeCloseTo(3, 5);
    });

    test('correct cost for 1M output tokens on Sonnet', () => {
        const cost = calculateCost(0, 1_000_000, 'claude-sonnet-4-6');
        expect(cost).toBeCloseTo(15, 5);
    });

    test('cost = input_cost + output_cost (additivity)', () => {
        const inputOnly = calculateCost(10000, 0, 'claude-opus-4-6')!;
        const outputOnly = calculateCost(0, 5000, 'claude-opus-4-6')!;
        const combined = calculateCost(10000, 5000, 'claude-opus-4-6')!;
        expect(combined).toBeCloseTo(inputOnly + outputOnly, 10);
    });

    // Property: cost scales linearly with token count
    test('cost scales linearly with token count', () => {
        const cost1 = calculateCost(100, 100, 'claude-sonnet-4-6')!;
        const cost2 = calculateCost(200, 200, 'claude-sonnet-4-6')!;
        expect(cost2).toBeCloseTo(cost1 * 2, 10);
    });

    // Property: cost is never negative for valid inputs
    test('cost is never negative for non-negative inputs', () => {
        const models = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
        for (const m of models) {
            for (const input of [0, 1, 100, 100000, 1000000]) {
                for (const output of [0, 1, 100, 100000, 1000000]) {
                    const cost = calculateCost(input, output, m);
                    expect(cost).not.toBeNull();
                    expect(cost!).toBeGreaterThanOrEqual(0);
                }
            }
        }
    });

    // Property: Opus > Sonnet > Haiku for same token counts
    test('Opus costs more than Sonnet, Sonnet costs more than Haiku', () => {
        const opus = calculateCost(10000, 5000, 'claude-opus-4-6')!;
        const sonnet = calculateCost(10000, 5000, 'claude-sonnet-4-6')!;
        const haiku = calculateCost(10000, 5000, 'claude-haiku-4-5')!;
        expect(opus).toBeGreaterThan(sonnet);
        expect(sonnet).toBeGreaterThan(haiku);
    });

    // Floating point accumulation test
    test('accumulated small costs vs direct calculation', () => {
        let sum = 0;
        for (let i = 0; i < 10000; i++) {
            sum += calculateCost(1, 0, 'claude-sonnet-4-6')!;
        }
        const direct = calculateCost(10000, 0, 'claude-sonnet-4-6')!;
        // They may not be exactly equal due to floating point, but should be close
        expect(sum).toBeCloseTo(direct, 8);
    });
});

// ── getContextWindowSize ────────────────────────────────────────────────────

describe('getContextWindowSize', () => {
    test('returns 200000 for all known models', () => {
        expect(getContextWindowSize('claude-opus-4-6')).toBe(200_000);
        expect(getContextWindowSize('claude-sonnet-4-6')).toBe(200_000);
        expect(getContextWindowSize('claude-haiku-4-5')).toBe(200_000);
    });

    test('returns 200000 for unknown model (default fallback)', () => {
        expect(getContextWindowSize('unknown-model')).toBe(200_000);
    });

    test('returns 200000 for empty string', () => {
        expect(getContextWindowSize('')).toBe(200_000);
    });
});
