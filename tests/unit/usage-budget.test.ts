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
import { computeUsageBudget } from '../../lib/usage-budget';
import type { UsageLimitsData } from '../../lib/message-types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-07T00:00:00.000Z').getTime(); // Fixed "now" for deterministic tests

function makeReset(minutesFromNow: number): string {
    return new Date(NOW + minutesFromNow * 60000).toISOString();
}

function makeLimits(sessionPct: number, weeklyPct: number, sessionMinutes = 60): UsageLimitsData {
    const weeklyResetsAt = new Date('2026-04-08T09:00:00.000Z').toISOString();
    return {
        fiveHour: { utilization: sessionPct, resetsAt: makeReset(sessionMinutes) },
        sevenDay: { utilization: weeklyPct, resetsAt: weeklyResetsAt },
        capturedAt: NOW,
    };
}

// ── Zone classification ───────────────────────────────────────────────────────

describe('computeUsageBudget -- zone classification', () => {
    it('classifies 49% as comfortable', () => {
        const result = computeUsageBudget(makeLimits(49, 0), NOW);
        expect(result.zone).toBe('comfortable');
    });

    it('classifies 50% as moderate', () => {
        const result = computeUsageBudget(makeLimits(50, 0), NOW);
        expect(result.zone).toBe('moderate');
    });

    it('classifies 74% as moderate', () => {
        const result = computeUsageBudget(makeLimits(74, 0), NOW);
        expect(result.zone).toBe('moderate');
    });

    it('classifies 75% as tight', () => {
        const result = computeUsageBudget(makeLimits(75, 0), NOW);
        expect(result.zone).toBe('tight');
    });

    it('classifies 89% as tight', () => {
        const result = computeUsageBudget(makeLimits(89, 0), NOW);
        expect(result.zone).toBe('tight');
    });

    it('classifies 90% as critical', () => {
        const result = computeUsageBudget(makeLimits(90, 0), NOW);
        expect(result.zone).toBe('critical');
    });

    it('classifies 100% as critical', () => {
        const result = computeUsageBudget(makeLimits(100, 0), NOW);
        expect(result.zone).toBe('critical');
    });
});

// ── Zone uses max(session, weekly) ───────────────────────────────────────────

describe('computeUsageBudget -- zone based on max utilization', () => {
    it('uses weekly pct when weekly is higher than session', () => {
        // Session at 20% (comfortable), weekly at 85% (tight).
        // Zone should be tight, not comfortable.
        const result = computeUsageBudget(makeLimits(20, 85), NOW);
        expect(result.zone).toBe('tight');
    });

    it('uses session pct when session is higher than weekly', () => {
        // Session at 92% (critical), weekly at 30% (comfortable).
        const result = computeUsageBudget(makeLimits(92, 30), NOW);
        expect(result.zone).toBe('critical');
    });

    it('returns correct individual pcts regardless of zone driver', () => {
        const result = computeUsageBudget(makeLimits(20, 85), NOW);
        expect(result.sessionPct).toBe(20);
        expect(result.weeklyPct).toBe(85);
    });
});

// ── Session reset countdown ───────────────────────────────────────────────────

describe('computeUsageBudget -- sessionMinutesUntilReset', () => {
    it('returns exact minutes until reset', () => {
        const result = computeUsageBudget(makeLimits(11, 0, 53), NOW);
        expect(result.sessionMinutesUntilReset).toBe(53);
    });

    it('floors at 0 when reset is in the past', () => {
        const pastLimits: UsageLimitsData = {
            fiveHour: { utilization: 11, resetsAt: new Date(NOW - 60000).toISOString() },
            sevenDay: { utilization: 0, resetsAt: new Date('2026-04-08T09:00:00.000Z').toISOString() },
            capturedAt: NOW,
        };
        const result = computeUsageBudget(pastLimits, NOW);
        expect(result.sessionMinutesUntilReset).toBe(0);
    });

    it('handles reset exactly at now as 0', () => {
        const nowLimits: UsageLimitsData = {
            fiveHour: { utilization: 50, resetsAt: new Date(NOW).toISOString() },
            sevenDay: { utilization: 0, resetsAt: new Date('2026-04-08T09:00:00.000Z').toISOString() },
            capturedAt: NOW,
        };
        const result = computeUsageBudget(nowLimits, NOW);
        expect(result.sessionMinutesUntilReset).toBe(0);
    });

    it('returns correct countdown for 1h 12m (72 minutes)', () => {
        const result = computeUsageBudget(makeLimits(30, 0, 72), NOW);
        expect(result.sessionMinutesUntilReset).toBe(72);
    });
});

// ── Weekly reset label ────────────────────────────────────────────────────────

describe('computeUsageBudget -- weeklyResetLabel', () => {
    it('formats the weekly reset as a short day + time string', () => {
        // 2026-04-08 is a Wednesday.
        const result = computeUsageBudget(makeLimits(11, 21), NOW);
        // The label should contain "Wed" (the day) and time info.
        // Intl formatting varies by locale, so we test the pattern not the exact string.
        expect(result.weeklyResetLabel).toMatch(/Wed/i);
    });

    it('produces a non-empty string', () => {
        const result = computeUsageBudget(makeLimits(11, 21), NOW);
        expect(result.weeklyResetLabel.length).toBeGreaterThan(3);
    });
});

// ── Status label ──────────────────────────────────────────────────────────────

describe('computeUsageBudget -- statusLabel', () => {
    it('contains the session utilization percentage', () => {
        const result = computeUsageBudget(makeLimits(11, 0, 53), NOW);
        expect(result.statusLabel).toContain('11%');
    });

    it('contains reset countdown for comfortable zone', () => {
        const result = computeUsageBudget(makeLimits(20, 0, 53), NOW);
        expect(result.statusLabel).toContain('resets in');
        expect(result.statusLabel).toContain('53 min');
    });

    it('contains reset countdown for tight zone', () => {
        const result = computeUsageBudget(makeLimits(80, 0, 23), NOW);
        expect(result.statusLabel).toContain('23 min');
    });

    it('uses urgency language for critical zone', () => {
        const result = computeUsageBudget(makeLimits(94, 0, 5), NOW);
        expect(result.statusLabel).toContain('exhausted');
    });

    it('formats hours correctly in countdown', () => {
        const result = computeUsageBudget(makeLimits(30, 0, 72), NOW);
        // 72 minutes = "1h 12m"
        expect(result.statusLabel).toContain('1h 12m');
    });

    it('shows exact hours when minutes are zero', () => {
        const result = computeUsageBudget(makeLimits(30, 0, 60), NOW);
        // 60 minutes = "1h"
        expect(result.statusLabel).toContain('1h');
        expect(result.statusLabel).not.toContain('0m');
    });
});

// ── Output structure ──────────────────────────────────────────────────────────

describe('computeUsageBudget -- output structure', () => {
    it('returns all required fields', () => {
        const result = computeUsageBudget(makeLimits(11, 21), NOW);
        expect(typeof result.sessionPct).toBe('number');
        expect(typeof result.weeklyPct).toBe('number');
        expect(typeof result.sessionMinutesUntilReset).toBe('number');
        expect(typeof result.weeklyResetLabel).toBe('string');
        expect(typeof result.zone).toBe('string');
        expect(typeof result.statusLabel).toBe('string');
    });

    it('passes through utilization values unchanged', () => {
        const result = computeUsageBudget(makeLimits(11, 21), NOW);
        expect(result.sessionPct).toBe(11);
        expect(result.weeklyPct).toBe(21);
    });
});
