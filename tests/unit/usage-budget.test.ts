// tests/unit/usage-budget.test.ts
// Unit tests for the Usage Budget Agent (lib/usage-budget.ts).
//
// The agent transforms raw Anthropic usage data from /api/organizations/{orgId}/usage
// into display-ready budget results. All values are exact (from timestamps), not estimated.
//
// Test matrix:
//   - Zone boundaries at 49/50/74/75/89/90 percent
//   - Zone uses max(sessionPct, weeklyPct) not just sessionPct
//   - Session reset countdown is exact (millisecond math, not estimated)
//   - Reset countdown floors at 0 (never shows negative minutes)
//   - Weekly reset label formats as "Wed 9:00 AM"
//   - Status label contains the session percentage
//   - Status label adapts to zone (critical gets urgency text)
//   - Handles past resetAt timestamps gracefully (shows 0 min)

import { describe, it, expect } from 'vitest';
import { computeUsageBudget, getTrackedUtilization } from '../../lib/usage-budget';
import type { UsageLimitsData, UsageBudgetSession, UsageBudgetCredit } from '../../lib/message-types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-07T00:00:00.000Z').getTime(); // Fixed "now" for deterministic tests

function makeReset(minutesFromNow: number): string {
    return new Date(NOW + minutesFromNow * 60000).toISOString();
}

function makeLimits(sessionPct: number, weeklyPct: number, sessionMinutes = 60): UsageLimitsData {
    const weeklyResetsAt = new Date('2026-04-08T09:00:00.000Z').toISOString();
    return {
        kind: 'session',
        fiveHour: { utilization: sessionPct, resetsAt: makeReset(sessionMinutes) },
        sevenDay: { utilization: weeklyPct, resetsAt: weeklyResetsAt },
        capturedAt: NOW,
    };
}

function makeCreditLimits(opts: {
    monthlyLimitCents?: number;
    usedCents?: number;
    utilizationPct?: number;
    currency?: string;
} = {}): UsageLimitsData {
    return {
        kind: 'credit',
        monthlyLimitCents: opts.monthlyLimitCents ?? 50000,
        usedCents: opts.usedCents ?? 30491,
        utilizationPct: opts.utilizationPct ?? 60.982,
        currency: opts.currency ?? 'USD',
        capturedAt: NOW,
    };
}

// Helpers: every test in the existing session-tier suite only needs a session
// variant back. Narrow once and let the assertions stay readable.
function computeSession(limits: UsageLimitsData, now: number): UsageBudgetSession {
    const result = computeUsageBudget(limits, now);
    if (result.kind !== 'session') throw new Error(`expected session, got ${result.kind}`);
    return result;
}

function computeCredit(limits: UsageLimitsData, now: number): UsageBudgetCredit {
    const result = computeUsageBudget(limits, now);
    if (result.kind !== 'credit') throw new Error(`expected credit, got ${result.kind}`);
    return result;
}

// ── Zone classification ───────────────────────────────────────────────────────

describe('computeUsageBudget -- zone classification', () => {
    it('classifies 49% as comfortable', () => {
        const result = computeSession(makeLimits(49, 0), NOW);
        expect(result.zone).toBe('comfortable');
    });

    it('classifies 50% as moderate', () => {
        const result = computeSession(makeLimits(50, 0), NOW);
        expect(result.zone).toBe('moderate');
    });

    it('classifies 74% as moderate', () => {
        const result = computeSession(makeLimits(74, 0), NOW);
        expect(result.zone).toBe('moderate');
    });

    it('classifies 75% as tight', () => {
        const result = computeSession(makeLimits(75, 0), NOW);
        expect(result.zone).toBe('tight');
    });

    it('classifies 89% as tight', () => {
        const result = computeSession(makeLimits(89, 0), NOW);
        expect(result.zone).toBe('tight');
    });

    it('classifies 90% as critical', () => {
        const result = computeSession(makeLimits(90, 0), NOW);
        expect(result.zone).toBe('critical');
    });

    it('classifies 100% as critical', () => {
        const result = computeSession(makeLimits(100, 0), NOW);
        expect(result.zone).toBe('critical');
    });
});

// ── Zone uses max(session, weekly) ───────────────────────────────────────────

describe('computeUsageBudget -- zone based on max utilization', () => {
    it('uses weekly pct when weekly is higher than session', () => {
        // Session at 20% (comfortable), weekly at 85% (tight).
        // Zone should be tight, not comfortable.
        const result = computeSession(makeLimits(20, 85), NOW);
        expect(result.zone).toBe('tight');
    });

    it('uses session pct when session is higher than weekly', () => {
        // Session at 92% (critical), weekly at 30% (comfortable).
        const result = computeSession(makeLimits(92, 30), NOW);
        expect(result.zone).toBe('critical');
    });

    it('returns correct individual pcts regardless of zone driver', () => {
        const result = computeSession(makeLimits(20, 85), NOW);
        expect(result.sessionPct).toBe(20);
        expect(result.weeklyPct).toBe(85);
    });
});

// ── Session reset countdown ───────────────────────────────────────────────────

describe('computeUsageBudget -- sessionMinutesUntilReset', () => {
    it('returns exact minutes until reset', () => {
        const result = computeSession(makeLimits(11, 0, 53), NOW);
        expect(result.sessionMinutesUntilReset).toBe(53);
    });

    it('floors at 0 when reset is in the past', () => {
        const pastLimits: UsageLimitsData = {
            kind: 'session',
            fiveHour: { utilization: 11, resetsAt: new Date(NOW - 60000).toISOString() },
            sevenDay: { utilization: 0, resetsAt: new Date('2026-04-08T09:00:00.000Z').toISOString() },
            capturedAt: NOW,
        };
        const result = computeSession(pastLimits, NOW);
        expect(result.sessionMinutesUntilReset).toBe(0);
    });

    it('handles reset exactly at now as 0', () => {
        const nowLimits: UsageLimitsData = {
            kind: 'session',
            fiveHour: { utilization: 50, resetsAt: new Date(NOW).toISOString() },
            sevenDay: { utilization: 0, resetsAt: new Date('2026-04-08T09:00:00.000Z').toISOString() },
            capturedAt: NOW,
        };
        const result = computeSession(nowLimits, NOW);
        expect(result.sessionMinutesUntilReset).toBe(0);
    });

    it('returns correct countdown for 1h 12m (72 minutes)', () => {
        const result = computeSession(makeLimits(30, 0, 72), NOW);
        expect(result.sessionMinutesUntilReset).toBe(72);
    });
});

// ── Weekly reset label ────────────────────────────────────────────────────────

describe('computeUsageBudget -- weeklyResetLabel', () => {
    it('formats the weekly reset as a short day + time string', () => {
        // 2026-04-08 is a Wednesday.
        const result = computeSession(makeLimits(11, 21), NOW);
        // The label should contain "Wed" (the day) and time info.
        // Intl formatting varies by locale, so we test the pattern not the exact string.
        expect(result.weeklyResetLabel).toMatch(/Wed/i);
    });

    it('produces a non-empty string', () => {
        const result = computeSession(makeLimits(11, 21), NOW);
        expect(result.weeklyResetLabel.length).toBeGreaterThan(3);
    });
});

// ── Status label ──────────────────────────────────────────────────────────────

describe('computeUsageBudget -- statusLabel', () => {
    it('contains the session utilization percentage', () => {
        const result = computeSession(makeLimits(11, 0, 53), NOW);
        expect(result.statusLabel).toContain('11%');
    });

    it('contains reset countdown for comfortable zone', () => {
        const result = computeSession(makeLimits(20, 0, 53), NOW);
        expect(result.statusLabel).toContain('resets in');
        expect(result.statusLabel).toContain('53 min');
    });

    it('contains reset countdown for tight zone', () => {
        const result = computeSession(makeLimits(80, 0, 23), NOW);
        expect(result.statusLabel).toContain('23 min');
    });

    it('uses urgency language for critical zone', () => {
        const result = computeSession(makeLimits(94, 0, 5), NOW);
        expect(result.statusLabel).toContain('exhausted');
    });

    it('formats hours correctly in countdown', () => {
        const result = computeSession(makeLimits(30, 0, 72), NOW);
        // 72 minutes = "1h 12m"
        expect(result.statusLabel).toContain('1h 12m');
    });

    it('shows exact hours when minutes are zero', () => {
        const result = computeSession(makeLimits(30, 0, 60), NOW);
        // 60 minutes = "1h"
        expect(result.statusLabel).toContain('1h');
        expect(result.statusLabel).not.toContain('0m');
    });
});

// ── Output structure ──────────────────────────────────────────────────────────

describe('computeUsageBudget -- output structure', () => {
    it('returns all required fields', () => {
        const result = computeSession(makeLimits(11, 21), NOW);
        expect(typeof result.sessionPct).toBe('number');
        expect(typeof result.weeklyPct).toBe('number');
        expect(typeof result.sessionMinutesUntilReset).toBe('number');
        expect(typeof result.weeklyResetLabel).toBe('string');
        expect(typeof result.zone).toBe('string');
        expect(typeof result.statusLabel).toBe('string');
    });

    it('passes through utilization values unchanged', () => {
        const result = computeSession(makeLimits(11, 21), NOW);
        expect(result.sessionPct).toBe(11);
        expect(result.weeklyPct).toBe(21);
    });
});

// ── Credit variant (Enterprise) ───────────────────────────────────────────────
// Anchored on the fixture from Devanshu's Northeastern Enterprise account
// (2026-04-23): $500.00 monthly cap, $304.91 spent, 60.982% utilization, USD.

describe('computeUsageBudget -- credit variant', () => {
    it('discriminates as credit', () => {
        const result = computeUsageBudget(makeCreditLimits(), NOW);
        expect(result.kind).toBe('credit');
    });

    it('passes cents and currency through unchanged', () => {
        const result = computeCredit(makeCreditLimits(), NOW);
        expect(result.monthlyLimitCents).toBe(50000);
        expect(result.usedCents).toBe(30491);
        expect(result.utilizationPct).toBeCloseTo(60.982, 3);
        expect(result.currency).toBe('USD');
    });

    it('formats the status label as currency-aware "$X of $Y spent"', () => {
        const result = computeCredit(makeCreditLimits(), NOW);
        // Intl-formatted USD on en-US: "$304.91 of $500.00 spent"
        expect(result.statusLabel).toContain('304.91');
        expect(result.statusLabel).toContain('500.00');
        expect(result.statusLabel).toContain('spent');
    });

    it('renders a reset label of "Resets {Mon DD}" using next-month rollover', () => {
        // NOW is 2026-04-07 → next month resets on May 1.
        const result = computeCredit(makeCreditLimits(), NOW);
        expect(result.resetLabel.startsWith('Resets ')).toBe(true);
        expect(result.resetLabel).toMatch(/May/);
        expect(result.resetLabel).toMatch(/\b1\b/);
    });

    it('rolls over from December to the following January', () => {
        const dec = new Date('2026-12-15T00:00:00.000Z').getTime();
        const result = computeCredit(makeCreditLimits(), dec);
        expect(result.resetLabel).toMatch(/Jan/);
        expect(result.resetLabel).toMatch(/\b1\b/);
    });

    it('classifies zone from utilizationPct alone (49% → comfortable)', () => {
        const result = computeCredit(makeCreditLimits({ utilizationPct: 49 }), NOW);
        expect(result.zone).toBe('comfortable');
    });

    it('classifies zone from utilizationPct alone (50% → moderate)', () => {
        const result = computeCredit(makeCreditLimits({ utilizationPct: 50 }), NOW);
        expect(result.zone).toBe('moderate');
    });

    it('classifies zone from utilizationPct alone (74% → moderate)', () => {
        const result = computeCredit(makeCreditLimits({ utilizationPct: 74 }), NOW);
        expect(result.zone).toBe('moderate');
    });

    it('classifies zone from utilizationPct alone (75% → tight)', () => {
        const result = computeCredit(makeCreditLimits({ utilizationPct: 75 }), NOW);
        expect(result.zone).toBe('tight');
    });

    it('classifies zone from utilizationPct alone (89% → tight)', () => {
        const result = computeCredit(makeCreditLimits({ utilizationPct: 89 }), NOW);
        expect(result.zone).toBe('tight');
    });

    it('classifies zone from utilizationPct alone (90% → critical)', () => {
        const result = computeCredit(makeCreditLimits({ utilizationPct: 90 }), NOW);
        expect(result.zone).toBe('critical');
    });

    it('formats unknown currency codes as a "CODE 304.91" fallback', () => {
        // Intl rejects nonsense currency codes. The agent must not crash; it
        // falls through to a portable form so the card never shows NaN.
        const result = computeCredit(makeCreditLimits({ currency: 'XYZ' }), NOW);
        expect(result.currency).toBe('XYZ');
        expect(result.statusLabel).toContain('XYZ');
        expect(result.statusLabel).toContain('304.91');
    });
});

// ── Unsupported variant ──────────────────────────────────────────────────────

describe('computeUsageBudget -- unsupported variant', () => {
    it('passes through as a kinded result with no fields', () => {
        const result = computeUsageBudget({ kind: 'unsupported', capturedAt: NOW }, NOW);
        expect(result.kind).toBe('unsupported');
    });
});

// ── getTrackedUtilization ────────────────────────────────────────────────────

describe('getTrackedUtilization', () => {
    it('returns sessionPct on the session variant', () => {
        const session = computeSession(makeLimits(37, 12), NOW);
        expect(getTrackedUtilization(session)).toBe(37);
    });

    it('returns utilizationPct on the credit variant', () => {
        const credit = computeCredit(makeCreditLimits({ utilizationPct: 60.982 }), NOW);
        expect(getTrackedUtilization(credit)).toBeCloseTo(60.982, 3);
    });
});
