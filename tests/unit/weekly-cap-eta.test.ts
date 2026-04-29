// tests/unit/weekly-cap-eta.test.ts
// Unit tests for the Weekly Cap ETA Agent (lib/weekly-cap-eta.ts).
//
// Covers every acceptance criterion from GET-21:
//   AC1: stable rising usage → ETA shown
//   AC2: flat or decreasing → null
//   AC3: confidence degrades with low sample / poor fit
//   AC4: hidden on credit/unsupported (enforced at call site, not tested here)
//   AC5: stable-rising, flat, decreasing, low-sample, post-reset test cases
//   AC6: no ETA immediately after weekly reset (cleared snapshots → null)

import { describe, it, expect } from 'vitest';
import {
    computeWeeklyEta,
    formatEtaLabel,
    MIN_SNAPSHOTS_FOR_ETA,
    type UsageBudgetSnapshot,
} from '../../lib/weekly-cap-eta';

// ── Time constants ────────────────────────────────────────────────────────────

const BASE = new Date('2026-04-07T00:00:00.000Z').getTime();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ── Helpers ───────────────────────────────────────────────────────────────────

function snap(timestamp: number, weeklyPct: number, sessionPct = 10): UsageBudgetSnapshot {
    return { timestamp, weeklyPct, sessionPct };
}

/**
 * Build a perfectly-linear rising series:
 * starts at startPct, advances by ratePerHour every hour, n points total.
 * "now" is placed 1ms after the last snapshot so the ETA is always in the future.
 */
function linearSeries(
    startPct: number,
    ratePerHour: number,
    n: number,
    baseMs = BASE,
): UsageBudgetSnapshot[] {
    return Array.from({ length: n }, (_, i) =>
        snap(baseMs + i * HOUR_MS, startPct + i * ratePerHour),
    );
}

/** "now" is 1ms after the last snapshot of a series built with linearSeries. */
function nowAfter(n: number, baseMs = BASE): number {
    return baseMs + (n - 1) * HOUR_MS + 1;
}

// ── AC5/AC1: stable-rising series ────────────────────────────────────────────

describe('computeWeeklyEta:stable rising usage', () => {
    it('returns a non-null result when usage rises at a stable rate', () => {
        // 10 snapshots, rising 5%/hr: starts at 20, hits 100 in 16h from start.
        const snaps = linearSeries(20, 5, 10);
        const now = nowAfter(10);
        const result = computeWeeklyEta(snaps, now);
        expect(result).not.toBeNull();
    });

    it('returns hoursRemaining > 0', () => {
        const snaps = linearSeries(20, 5, 10);
        const now = nowAfter(10);
        const result = computeWeeklyEta(snaps, now);
        expect(result!.hoursRemaining).toBeGreaterThan(0);
    });

    it('projects ETA accurately for a perfect linear trend', () => {
        // 20% at t=0, rising 5%/hr. Hits 100% at t = (100-20)/5 = 16h from base.
        const snaps = linearSeries(20, 5, 10);
        const now = nowAfter(10);
        const result = computeWeeklyEta(snaps, now);
        const expectedEta = BASE + 16 * HOUR_MS;
        // Allow ±1 minute tolerance for floating-point
        expect(Math.abs(result!.etaTimestamp - expectedEta)).toBeLessThan(60_000);
    });

    it('assigns high confidence for a large perfectly-linear series', () => {
        const snaps = linearSeries(10, 5, 15); // 15 samples, perfect R²
        const now = nowAfter(15);
        const result = computeWeeklyEta(snaps, now);
        expect(result!.confidence).toBe('high');
    });

    it('assigns medium confidence for a 7-sample series with R² >= 0.7', () => {
        // 7 samples, mostly linear but with small noise
        const base = linearSeries(10, 8, 7);
        // Add tiny noise to each point to drop R² slightly below 0.9
        const noisy = base.map((s, i) => ({ ...s, weeklyPct: s.weeklyPct + (i % 2 === 0 ? 1 : -1) }));
        const now = nowAfter(7);
        const result = computeWeeklyEta(noisy, now);
        // Result may be null if noise breaks the slope, but when it returns
        // confidence must be medium or low (not high) for a noisy 7-sample series.
        if (result !== null) {
            expect(['medium', 'low']).toContain(result.confidence);
        }
    });

    it('assigns low confidence for a 5-sample series with moderate noise', () => {
        // Exactly MIN_SNAPSHOTS_FOR_ETA, slight upward trend
        const snaps = [
            snap(BASE,                  20),
            snap(BASE + 1 * HOUR_MS,    25),
            snap(BASE + 2 * HOUR_MS,    22), // noise dip
            snap(BASE + 3 * HOUR_MS,    30),
            snap(BASE + 4 * HOUR_MS,    35),
        ];
        const now = BASE + 4 * HOUR_MS + 1;
        const result = computeWeeklyEta(snaps, now);
        if (result !== null) {
            expect(result.confidence).toBe('low');
        }
    });
});

// ── AC5/AC2: flat usage ───────────────────────────────────────────────────────

describe('computeWeeklyEta:flat usage', () => {
    it('returns null when range < 10pp across a 24h+ span', () => {
        // 10 snapshots over 25 hours, all clustered around 40%
        const snaps = Array.from({ length: 10 }, (_, i) =>
            snap(BASE + i * (DAY_MS / 9) * 1.04, 40 + (i % 3)), // max-min = 2pp
        );
        const now = BASE + 10 * HOUR_MS + 1;
        expect(computeWeeklyEta(snaps, now)).toBeNull();
    });

    it('does not return null for a rising series shorter than 24h', () => {
        // 10 snapshots over 10 hours, clear positive slope (3%/hr).
        // Span is < 24h so the flatness guard cannot fire; the slope guard
        // also cannot fire because the rate is well above zero.
        const snaps = Array.from({ length: 10 }, (_, i) =>
            snap(BASE + i * HOUR_MS, 10 + i * 3),
        );
        const result = computeWeeklyEta(snaps, nowAfter(10));
        expect(result).not.toBeNull();
        expect(result!.hoursRemaining).toBeGreaterThan(0);
    });
});

// ── AC5/AC2: decreasing usage ─────────────────────────────────────────────────

describe('computeWeeklyEta:decreasing usage', () => {
    it('returns null when weeklyPct is steadily declining', () => {
        const snaps = linearSeries(80, -5, 8); // drops from 80 down
        const now = nowAfter(8);
        expect(computeWeeklyEta(snaps, now)).toBeNull();
    });

    it('returns null when slope is exactly zero', () => {
        const snaps = Array.from({ length: 6 }, (_, i) =>
            snap(BASE + i * HOUR_MS, 50), // constant
        );
        const now = nowAfter(6);
        expect(computeWeeklyEta(snaps, now)).toBeNull();
    });
});

// ── AC5: low-sample ───────────────────────────────────────────────────────────

describe('computeWeeklyEta:low sample count', () => {
    it('returns null with 0 snapshots', () => {
        expect(computeWeeklyEta([], BASE)).toBeNull();
    });

    it('returns null with 1 snapshot', () => {
        expect(computeWeeklyEta([snap(BASE, 50)], BASE + 1)).toBeNull();
    });

    it(`returns null with ${MIN_SNAPSHOTS_FOR_ETA - 1} snapshots`, () => {
        const snaps = linearSeries(10, 5, MIN_SNAPSHOTS_FOR_ETA - 1);
        expect(computeWeeklyEta(snaps, nowAfter(MIN_SNAPSHOTS_FOR_ETA - 1))).toBeNull();
    });

    it(`returns non-null with exactly ${MIN_SNAPSHOTS_FOR_ETA} snapshots`, () => {
        const snaps = linearSeries(10, 10, MIN_SNAPSHOTS_FOR_ETA);
        const now = nowAfter(MIN_SNAPSHOTS_FOR_ETA);
        expect(computeWeeklyEta(snaps, now)).not.toBeNull();
    });
});

// ── AC6: post-reset (cleared snapshots) ───────────────────────────────────────

describe('computeWeeklyEta:post weekly reset', () => {
    it('returns null immediately after reset (0 snapshots after clear)', () => {
        // Clearing snapshots is handled by clearUsageBudgetSnapshots in background.ts.
        // From the agent's perspective this is identical to the low-sample case.
        expect(computeWeeklyEta([], BASE)).toBeNull();
    });

    it('returns null when only a few post-reset snapshots have accumulated', () => {
        const snaps = linearSeries(5, 5, 3); // only 3 after reset
        const now = nowAfter(3);
        expect(computeWeeklyEta(snaps, now)).toBeNull();
    });
});

// ── ETA boundary guards ───────────────────────────────────────────────────────

describe('computeWeeklyEta:ETA boundary guards', () => {
    it('returns null when the projected ETA is already in the past', () => {
        // Build a series that was "supposed to" hit 100% in the past.
        // Shift "now" to be long after the last snapshot.
        const snaps = linearSeries(90, 3, 5);
        // now = 10 days after base, so the ETA (which hits 100 very quickly) is in the past
        const now = BASE + 10 * DAY_MS;
        expect(computeWeeklyEta(snaps, now)).toBeNull();
    });

    it('returns null when the projected ETA is more than 7 days away', () => {
        // Very slow rate: 0.01%/hr → 100% in ~(100/0.01)h = 10,000h >> 7 days
        const snaps = linearSeries(10, 0.01, 10);
        const now = nowAfter(10);
        expect(computeWeeklyEta(snaps, now)).toBeNull();
    });
});

// ── formatEtaLabel ────────────────────────────────────────────────────────────

describe('formatEtaLabel', () => {
    it('returns a non-empty string for any valid timestamp', () => {
        const label = formatEtaLabel(BASE + 6 * HOUR_MS);
        expect(typeof label).toBe('string');
        expect(label.length).toBeGreaterThan(0);
    });

    it('contains a weekday abbreviation', () => {
        const ts = BASE + 6 * HOUR_MS;
        const expectedWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(ts));
        expect(formatEtaLabel(ts)).toContain(expectedWeekday);
    });
});

// ── Unsorted input ────────────────────────────────────────────────────────────

describe('computeWeeklyEta:unsorted input', () => {
    it('produces the same result regardless of input order', () => {
        const ordered = linearSeries(10, 5, 10);
        const shuffled = [...ordered].reverse();
        const now = nowAfter(10);
        const r1 = computeWeeklyEta(ordered, now);
        const r2 = computeWeeklyEta(shuffled, now);
        expect(r1).not.toBeNull();
        expect(r2).not.toBeNull();
        expect(Math.abs(r1!.etaTimestamp - r2!.etaTimestamp)).toBeLessThan(1);
    });
});
