// tests/unit/delta-tracking.test.ts
// Tests for delta utilization computation logic.
//
// The actual snapshot-and-subtract runs in the content script (not a pure function),
// so these tests validate the computation rules and edge cases directly.
// They also verify the Token Economics agent integration with delta data.

import { describe, it, expect } from 'vitest';
import { computeTokenEconomics, MIN_SAMPLES } from '../../lib/token-economics';
import type { UsageDelta } from '../../lib/conversation-store';

// ── Delta computation rules ───────────────────────────────────────────────────

/**
 * Mirror the delta computation from the content script STREAM_COMPLETE handler.
 * If the logic changes there, update this function to match.
 */
function computeDelta(
    utilizationBefore: number | null,
    utilizationAfter: number | null,
): number | null {
    if (
        utilizationBefore !== null &&
        utilizationAfter !== null &&
        utilizationAfter > utilizationBefore
    ) {
        return utilizationAfter - utilizationBefore;
    }
    return null;
}

describe('delta computation', () => {
    it('returns the difference when after > before', () => {
        expect(computeDelta(10, 13)).toBe(3);
        expect(computeDelta(0, 2.5)).toBe(2.5);
        expect(computeDelta(87.3, 90.1)).toBeCloseTo(2.8);
    });

    it('returns null when before-snapshot is null (first load, no prior fetch)', () => {
        expect(computeDelta(null, 15)).toBeNull();
    });

    it('returns null when after-snapshot is null (fetch failure)', () => {
        expect(computeDelta(10, null)).toBeNull();
    });

    it('returns null when both snapshots are null', () => {
        expect(computeDelta(null, null)).toBeNull();
    });

    it('returns null when after === before (no usage in this message, or duplicate event)', () => {
        expect(computeDelta(10, 10)).toBeNull();
    });

    it('returns null when after < before (session reset between snapshots)', () => {
        // Session resets return the utilization to a low value.
        // e.g. before = 95% → session resets → after = 2%
        expect(computeDelta(95, 2)).toBeNull();
        expect(computeDelta(50, 49.9)).toBeNull();
    });

    it('handles fractional percentage point deltas', () => {
        // Anthropic returns fractional utilization; small messages cost < 1%.
        expect(computeDelta(3.14159, 3.41592)).toBeCloseTo(0.274, 2);
    });
});

// ── Token Economics integration with real delta data ──────────────────────────

function makeDelta(model: string, deltaUtilization: number, inputTokens = 1000, outputTokens = 200): UsageDelta {
    return {
        conversationId: 'test-conv',
        model,
        inputTokens,
        outputTokens,
        deltaUtilization,
        cost: null,
        timestamp: Date.now(),
    };
}

describe('computeTokenEconomics with delta data', () => {
    it('returns empty Maps when no deltas exist', () => {
        const result = computeTokenEconomics([]);
        expect(result.medianTokensPer1Pct.size).toBe(0);
        expect(result.sampleSize.size).toBe(0);
    });

    it('excludes models with fewer than MIN_SAMPLES records', () => {
        const deltas: UsageDelta[] = [];
        for (let i = 0; i < MIN_SAMPLES - 1; i++) {
            deltas.push(makeDelta('claude-sonnet-4-6', 2.0));
        }
        const result = computeTokenEconomics(deltas);
        expect(result.medianTokensPer1Pct.has('claude-sonnet-4-6')).toBe(false);
    });

    it('includes models with exactly MIN_SAMPLES records', () => {
        const deltas: UsageDelta[] = [];
        for (let i = 0; i < MIN_SAMPLES; i++) {
            deltas.push(makeDelta('claude-haiku-4-5', 1.0, 800, 100));
        }
        const result = computeTokenEconomics(deltas);
        expect(result.medianTokensPer1Pct.has('claude-haiku-4-5')).toBe(true);
        expect(result.sampleSize.get('claude-haiku-4-5')).toBe(MIN_SAMPLES);
    });

    it('computes correct median tokens-per-1% for a known dataset', () => {
        // 5 records, each with 1200 total tokens and 2.0% delta → 600 tokens/1%.
        const deltas: UsageDelta[] = [];
        for (let i = 0; i < 5; i++) {
            deltas.push(makeDelta('claude-sonnet-4-6', 2.0, 1000, 200));
        }
        const result = computeTokenEconomics(deltas);
        // (1000 + 200) / 2.0 = 600 tokens per 1%.
        expect(result.medianTokensPer1Pct.get('claude-sonnet-4-6')).toBe(600);
    });

    it('handles multiple models independently', () => {
        const deltas: UsageDelta[] = [
            // 5 Sonnet records: 1200 tokens at 2% = 600 tokens/1%.
            ...Array.from({ length: 5 }, () => makeDelta('claude-sonnet-4-6', 2.0, 1000, 200)),
            // 5 Haiku records: 500 tokens at 1% = 500 tokens/1%.
            ...Array.from({ length: 5 }, () => makeDelta('claude-haiku-4-5', 1.0, 400, 100)),
        ];
        const result = computeTokenEconomics(deltas);
        expect(result.medianTokensPer1Pct.get('claude-sonnet-4-6')).toBe(600);
        expect(result.medianTokensPer1Pct.get('claude-haiku-4-5')).toBe(500);
    });

    it('excludes zero-delta records (would produce Infinity)', () => {
        const deltas: UsageDelta[] = [];
        // These should never reach the delta log (background.ts filters them),
        // but the agent handles them defensively.
        for (let i = 0; i < 5; i++) {
            deltas.push(makeDelta('claude-sonnet-4-6', 0, 1000, 200));
        }
        const result = computeTokenEconomics(deltas);
        // Zero-delta records are filtered out, leaving 0 valid samples.
        expect(result.medianTokensPer1Pct.has('claude-sonnet-4-6')).toBe(false);
    });
});

// ── medianPctPerInputToken ───────────────────────────────────────────────────

describe('medianPctPerInputToken', () => {
    it('empty for no data', () => {
        const result = computeTokenEconomics([]);
        expect(result.medianPctPerInputToken.size).toBe(0);
    });

    it('below MIN_SAMPLES produces no entry', () => {
        const deltas: UsageDelta[] = [];
        for (let i = 0; i < MIN_SAMPLES - 1; i++) {
            deltas.push(makeDelta('claude-sonnet-4-6', 2, 500, 100));
        }
        const result = computeTokenEconomics(deltas);
        expect(result.medianPctPerInputToken.has('claude-sonnet-4-6')).toBe(false);
    });

    it('computes median pct per input token correctly', () => {
        // 5 records: delta=2, input=500 each -> pctPerInput = 2/500 = 0.004
        const deltas: UsageDelta[] = [];
        for (let i = 0; i < 5; i++) {
            deltas.push(makeDelta('claude-sonnet-4-6', 2, 500, 100));
        }
        const result = computeTokenEconomics(deltas);
        expect(result.medianPctPerInputToken.has('claude-sonnet-4-6')).toBe(true);
        expect(result.medianPctPerInputToken.get('claude-sonnet-4-6')).toBeCloseTo(0.004, 5);
    });

    it('excludes records with zero input tokens', () => {
        const deltas: UsageDelta[] = [];
        // 5 records with zero input tokens (division by zero would crash)
        for (let i = 0; i < 5; i++) {
            deltas.push(makeDelta('claude-sonnet-4-6', 2, 0, 100));
        }
        const result = computeTokenEconomics(deltas);
        expect(result.medianPctPerInputToken.has('claude-sonnet-4-6')).toBe(false);
    });

    it('computes independently per model', () => {
        const deltas: UsageDelta[] = [];
        // Sonnet: delta=2, input=500 -> 0.004
        for (let i = 0; i < 5; i++) {
            deltas.push(makeDelta('claude-sonnet-4-6', 2, 500, 100));
        }
        // Haiku: delta=1, input=500 -> 0.002
        for (let i = 0; i < 5; i++) {
            deltas.push(makeDelta('claude-haiku-4-5', 1, 500, 100));
        }
        const result = computeTokenEconomics(deltas);
        expect(result.medianPctPerInputToken.get('claude-sonnet-4-6')).toBeCloseTo(0.004, 5);
        expect(result.medianPctPerInputToken.get('claude-haiku-4-5')).toBeCloseTo(0.002, 5);
    });

    it('takes median of varying values', () => {
        // 5 records with different input sizes: 200, 400, 500, 600, 800
        // delta=2 for all -> pctPerInput: 0.01, 0.005, 0.004, 0.00333, 0.0025
        // Sorted: 0.0025, 0.00333, 0.004, 0.005, 0.01 -> median = 0.004
        const inputs = [200, 400, 500, 600, 800];
        const deltas = inputs.map(inp => makeDelta('claude-sonnet-4-6', 2, inp, 100));
        const result = computeTokenEconomics(deltas);
        expect(result.medianPctPerInputToken.get('claude-sonnet-4-6')).toBeCloseTo(0.004, 5);
    });
});
