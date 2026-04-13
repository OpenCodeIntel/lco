import { describe, test, expect } from 'vitest';

// Audit: lib/token-economics.ts - median calculation, sample gating

import { computeTokenEconomics, MIN_SAMPLES, type TokenEconomicsResult } from '../../lib/token-economics';
import type { UsageDelta } from '../../lib/conversation-store';

function makeDelta(overrides: Partial<UsageDelta> = {}): UsageDelta {
    return {
        conversationId: 'conv-1',
        model: 'claude-sonnet-4-6',
        inputTokens: 500,
        outputTokens: 200,
        deltaUtilization: 2,
        cost: 0.01,
        timestamp: Date.now(),
        ...overrides,
    };
}

describe('computeTokenEconomics', () => {
    test('returns empty maps for empty input', () => {
        const result = computeTokenEconomics([]);
        expect(result.medianTokensPer1Pct.size).toBe(0);
        expect(result.medianPctPerInputToken.size).toBe(0);
        expect(result.sampleSize.size).toBe(0);
    });

    test('returns empty maps when below MIN_SAMPLES', () => {
        const deltas = Array.from({ length: 4 }, () => makeDelta());
        const result = computeTokenEconomics(deltas);
        expect(result.medianTokensPer1Pct.size).toBe(0);
    });

    test('computes median at exactly MIN_SAMPLES', () => {
        const deltas = Array.from({ length: 5 }, () => makeDelta({
            inputTokens: 500,
            outputTokens: 200,
            deltaUtilization: 2,
        }));
        const result = computeTokenEconomics(deltas);
        expect(result.medianTokensPer1Pct.has('claude-sonnet-4-6')).toBe(true);
        // tokensPerPct = (500 + 200) / 2 = 350
        expect(result.medianTokensPer1Pct.get('claude-sonnet-4-6')).toBe(350);
    });

    test('excludes records with deltaUtilization = 0', () => {
        const deltas = [
            ...Array.from({ length: 4 }, () => makeDelta({ deltaUtilization: 2 })),
            makeDelta({ deltaUtilization: 0 }),
        ];
        const result = computeTokenEconomics(deltas);
        // Only 4 valid records, below MIN_SAMPLES
        expect(result.medianTokensPer1Pct.size).toBe(0);
    });

    test('groups by model correctly', () => {
        const sonnet = Array.from({ length: 5 }, () => makeDelta({ model: 'claude-sonnet-4-6' }));
        const haiku = Array.from({ length: 5 }, () => makeDelta({ model: 'claude-haiku-4-5' }));
        const result = computeTokenEconomics([...sonnet, ...haiku]);
        expect(result.medianTokensPer1Pct.has('claude-sonnet-4-6')).toBe(true);
        expect(result.medianTokensPer1Pct.has('claude-haiku-4-5')).toBe(true);
        expect(result.sampleSize.get('claude-sonnet-4-6')).toBe(5);
        expect(result.sampleSize.get('claude-haiku-4-5')).toBe(5);
    });

    test('median calculation for odd count', () => {
        const deltas = [1, 3, 5, 7, 9].map(d =>
            makeDelta({ inputTokens: 100 * d, outputTokens: 0, deltaUtilization: d }),
        );
        // tokensPerPct for each: 100*d / d = 100 for all. Median = 100
        const result = computeTokenEconomics(deltas);
        expect(result.medianTokensPer1Pct.get('claude-sonnet-4-6')).toBe(100);
    });

    test('median calculation for even count', () => {
        const deltas = [
            makeDelta({ inputTokens: 100, outputTokens: 0, deltaUtilization: 1 }),
            makeDelta({ inputTokens: 200, outputTokens: 0, deltaUtilization: 1 }),
            makeDelta({ inputTokens: 300, outputTokens: 0, deltaUtilization: 1 }),
            makeDelta({ inputTokens: 400, outputTokens: 0, deltaUtilization: 1 }),
            makeDelta({ inputTokens: 500, outputTokens: 0, deltaUtilization: 1 }),
            makeDelta({ inputTokens: 600, outputTokens: 0, deltaUtilization: 1 }),
        ];
        // tokensPerPct: [100, 200, 300, 400, 500, 600], median = (300+400)/2 = 350
        const result = computeTokenEconomics(deltas);
        expect(result.medianTokensPer1Pct.get('claude-sonnet-4-6')).toBe(350);
    });

    test('pctPerInputToken is computed correctly', () => {
        const deltas = Array.from({ length: 5 }, () =>
            makeDelta({ inputTokens: 1000, deltaUtilization: 5 }),
        );
        // pctPerInput = 5 / 1000 = 0.005 for each
        const result = computeTokenEconomics(deltas);
        expect(result.medianPctPerInputToken.get('claude-sonnet-4-6')).toBeCloseTo(0.005, 10);
    });

    test('excludes zero-input records from pctPerInputToken', () => {
        const deltas = [
            ...Array.from({ length: 5 }, () => makeDelta({ inputTokens: 1000, deltaUtilization: 5 })),
            makeDelta({ inputTokens: 0, deltaUtilization: 2 }),
        ];
        const result = computeTokenEconomics(deltas);
        // Still should compute correctly; zero-input records are excluded from pctPerInput
        expect(result.medianPctPerInputToken.has('claude-sonnet-4-6')).toBe(true);
    });
});
