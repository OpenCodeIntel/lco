// tests/unit/usage-limits-parser.test.ts
// Unit tests for parseUsageResponse — the only place that classifies the
// raw /api/organizations/{orgId}/usage payload into a tier variant.
//
// The agents downstream all branch on `kind`, so any drift here produces
// silently wrong UI. The matrix below covers each branch + the boundary
// between "unparseable input we drop" and "200 with neither shape, surface
// as unsupported".
//
// Fixtures anchor on real responses captured 2026-04-23:
//   - session: a Pro account (utilization + resets_at on both windows)
//   - credit:  Devanshu's Northeastern Enterprise account
//                (extra_usage with $500 cap / $304.91 spent / 60.982%)

import { describe, it, expect } from 'vitest';
import { parseUsageResponse } from '../../lib/usage-limits-parser';

// ── Session shape (Pro / Personal / Max / Team) ──────────────────────────────

describe('parseUsageResponse -- session shape', () => {
    const sessionResponse = {
        five_hour: {
            utilization: 33.5,
            resets_at: '2026-04-07T05:00:00.000+00:00',
        },
        seven_day: {
            utilization: 12.1,
            resets_at: '2026-04-13T00:00:00.000+00:00',
        },
    };

    it('discriminates as session', () => {
        const result = parseUsageResponse(sessionResponse);
        expect(result?.kind).toBe('session');
    });

    it('passes the two windows through unchanged', () => {
        const result = parseUsageResponse(sessionResponse);
        if (result?.kind !== 'session') throw new Error('expected session');
        expect(result.fiveHour.utilization).toBe(33.5);
        expect(result.fiveHour.resetsAt).toBe('2026-04-07T05:00:00.000+00:00');
        expect(result.sevenDay.utilization).toBe(12.1);
        expect(result.sevenDay.resetsAt).toBe('2026-04-13T00:00:00.000+00:00');
    });

    it('stamps capturedAt at parse time', () => {
        const before = Date.now();
        const result = parseUsageResponse(sessionResponse);
        const after = Date.now();
        if (result?.kind !== 'session') throw new Error('expected session');
        expect(result.capturedAt).toBeGreaterThanOrEqual(before);
        expect(result.capturedAt).toBeLessThanOrEqual(after);
    });

    it('falls through to unsupported when only one window is populated', () => {
        // A half-populated session response is not a session response; we
        // would rather show "unsupported" than render half a card.
        const result = parseUsageResponse({
            five_hour: { utilization: 10, resets_at: '2026-04-07T05:00:00.000Z' },
            seven_day: null,
        });
        expect(result?.kind).toBe('unsupported');
    });

    it('falls through to unsupported when utilization is the wrong type', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: '33', resets_at: '2026-04-07T05:00:00.000Z' },
            seven_day: { utilization: 12, resets_at: '2026-04-13T00:00:00.000Z' },
        });
        expect(result?.kind).toBe('unsupported');
    });
});

// ── Credit shape (Enterprise) ────────────────────────────────────────────────

describe('parseUsageResponse -- credit shape', () => {
    // Verbatim fixture from Devanshu's Northeastern Enterprise account.
    const enterpriseResponse = {
        five_hour: null,
        seven_day: null,
        extra_usage: {
            is_enabled: true,
            monthly_limit: 50000,
            used_credits: 30491.0,
            utilization: 60.982,
            currency: 'USD',
        },
    };

    it('discriminates as credit', () => {
        const result = parseUsageResponse(enterpriseResponse);
        expect(result?.kind).toBe('credit');
    });

    it('passes the cents fields through unchanged', () => {
        const result = parseUsageResponse(enterpriseResponse);
        if (result?.kind !== 'credit') throw new Error('expected credit');
        expect(result.monthlyLimitCents).toBe(50000);
        expect(result.usedCents).toBe(30491);
        expect(result.utilizationPct).toBeCloseTo(60.982, 3);
        expect(result.currency).toBe('USD');
    });

    it('falls through to unsupported when extra_usage.is_enabled is false', () => {
        const result = parseUsageResponse({
            extra_usage: {
                is_enabled: false,
                monthly_limit: 50000,
                used_credits: 100,
                utilization: 0.2,
                currency: 'USD',
            },
        });
        expect(result?.kind).toBe('unsupported');
    });

    it('falls through to unsupported when a numeric field is missing', () => {
        // Half-credit shape: rather than render an incomplete bar we surface
        // the unsupported state and stay honest.
        const result = parseUsageResponse({
            extra_usage: {
                is_enabled: true,
                monthly_limit: 50000,
                used_credits: 100,
                // utilization missing
                currency: 'USD',
            },
        });
        expect(result?.kind).toBe('unsupported');
    });
});

// ── Unsupported (200, but neither shape) ─────────────────────────────────────

describe('parseUsageResponse -- unsupported', () => {
    it('returns unsupported for an empty object', () => {
        const result = parseUsageResponse({});
        expect(result?.kind).toBe('unsupported');
    });

    it('returns unsupported when both top-level windows are explicit null and credit is disabled', () => {
        // Some Teams accounts return this shape: nothing actionable to render.
        const result = parseUsageResponse({
            five_hour: null,
            seven_day: null,
            extra_usage: { is_enabled: false },
        });
        expect(result?.kind).toBe('unsupported');
    });

    it('stamps capturedAt on unsupported variants too', () => {
        const before = Date.now();
        const result = parseUsageResponse({});
        const after = Date.now();
        if (result?.kind !== 'unsupported') throw new Error('expected unsupported');
        expect(result.capturedAt).toBeGreaterThanOrEqual(before);
        expect(result.capturedAt).toBeLessThanOrEqual(after);
    });
});

// ── Null pass-through (unparseable) ──────────────────────────────────────────
// `null` here means "we cannot inspect the body at all"; the caller keeps any
// previous render in place rather than flipping to an empty state on a single
// transient bad response.

describe('parseUsageResponse -- unparseable input', () => {
    it('returns null for null', () => {
        expect(parseUsageResponse(null)).toBeNull();
    });

    it('returns null for a bare string', () => {
        expect(parseUsageResponse('hello')).toBeNull();
    });

    it('returns null for a bare number', () => {
        expect(parseUsageResponse(42)).toBeNull();
    });

    it('returns null for an array (not the object shape we expect)', () => {
        expect(parseUsageResponse([])).toBeNull();
    });
});

// ── Dispatch priority ────────────────────────────────────────────────────────

describe('parseUsageResponse -- dispatch priority', () => {
    it('prefers session when both shapes happen to be populated', () => {
        // We have not seen this combo in the wild, but the function must be
        // total. Session is the long-standing default; we lock in that choice.
        const result = parseUsageResponse({
            five_hour: { utilization: 10, resets_at: '2026-04-07T05:00:00.000Z' },
            seven_day: { utilization: 5, resets_at: '2026-04-13T00:00:00.000Z' },
            extra_usage: {
                is_enabled: true,
                monthly_limit: 50000,
                used_credits: 100,
                utilization: 0.2,
                currency: 'USD',
            },
        });
        expect(result?.kind).toBe('session');
    });
});
