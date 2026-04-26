// tests/unit/turn-ticker-trend.test.ts
// Locks in the absolute-percentage-point trend behavior for TurnTicker.
// The earlier draft of computeTrend reported relative percent change
// ((curr - prev) / prev) * 100, which on micro-values produced "↑ 2650%"
// and "↓ 97%" labels that read as catastrophic context rot when the
// underlying turns were 0.05% and 0.15% of session — totally healthy.
//
// The fix is to report the absolute pp delta in the same unit the bars
// are drawn in. These tests pin that contract so a future refactor of
// the trend math doesn't silently regress to the relative formula.

import { describe, it, expect } from 'vitest';
import { computeTrend } from '../../entrypoints/sidepanel/components/TurnTicker';

describe('TurnTicker computeTrend — absolute pp delta, not relative percent', () => {
    it('reports the absolute pp difference for upward moves', () => {
        // 0.05% -> 0.15% of session is a +0.10pp move, not a +200% move.
        // The bars carry the magnitude story; the label only adds direction
        // and the honest size of the change.
        const trend = computeTrend(0.05, 0.15);
        expect(trend).not.toBeNull();
        expect(trend!.direction).toBe('up');
        expect(trend!.percent).toBeCloseTo(0.10, 2);
    });

    it('reports the absolute pp difference for downward moves', () => {
        const trend = computeTrend(0.15, 0.05);
        expect(trend).not.toBeNull();
        expect(trend!.direction).toBe('down');
        expect(trend!.percent).toBeCloseTo(-0.10, 2);
    });

    it('does NOT explode on a near-zero previous turn (regression for the 2650% bug)', () => {
        // Prior bug: previous=0.005, current=0.137 -> ((0.137 - 0.005) / 0.005) * 100
        // = 2640%. Fix reports the absolute delta, ~0.13.
        const trend = computeTrend(0.005, 0.137);
        expect(trend).not.toBeNull();
        expect(trend!.percent).toBeCloseTo(0.132, 2);
        expect(Math.abs(trend!.percent)).toBeLessThan(1); // never absurd
    });

    it('suppresses moves below the noise floor (0.01 pp)', () => {
        // Tokenizer estimate is the floor of meaningful resolution. A 0.005pp
        // move is rounding noise; rendering it as "↑ 0.005%" would distract
        // without informing.
        expect(computeTrend(0.05, 0.054)).toBeNull();
        expect(computeTrend(0.05, 0.05)).toBeNull();
    });

    it('returns null when either input is null (no previous turn)', () => {
        expect(computeTrend(null, 0.15)).toBeNull();
        expect(computeTrend(0.15, null)).toBeNull();
        expect(computeTrend(null, null)).toBeNull();
    });

    it('handles a zero previous turn without dividing by zero (the original failure mode)', () => {
        // The relative formula crashed at this branch; absolute delta has
        // no such constraint. previous=0 is a legitimate first-tracked turn.
        const trend = computeTrend(0, 0.20);
        expect(trend).not.toBeNull();
        expect(trend!.direction).toBe('up');
        expect(trend!.percent).toBeCloseTo(0.20, 2);
    });
});
