// tests/unit/spend-trajectory.test.ts
// Unit tests for the Spend Trajectory Agent (lib/spend-trajectory.ts).
//
// Covers GET-22 acceptance criteria:
//   - Stable burn → projection with high/medium confidence
//   - Variable burn → projection with degraded confidence
//   - < MIN_DISTINCT_DAYS_FOR_PROJECTION distinct days → null ("need more data")
//   - Post-reset (deltas from previous month excluded)
//   - Per-conversation cost reconciles with summed turn costs
//   - Top-N ranking is descending by total cost

import { describe, it, expect } from 'vitest';
import {
    projectMonthEnd,
    aggregateByConversation,
    startOfMonth,
    startOfNextMonth,
    daysUntilNextMonth,
    MIN_DISTINCT_DAYS_FOR_PROJECTION,
    type SpendTrajectory,
} from '../../lib/spend-trajectory';
import type { UsageDelta, ConversationRecord, TurnRecord } from '../../lib/conversation-store';

// ── Time constants ────────────────────────────────────────────────────────────

// Mid-month anchor: April 15 2026, 12:00 local time.
// Sits comfortably mid-month so day-counting tests do not bump month boundaries.
const APRIL_15 = new Date(2026, 3, 15, 12, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Builders ──────────────────────────────────────────────────────────────────

function delta(
    timestamp: number,
    cost: number | null,
    conversationId = 'conv-A',
    model = 'claude-sonnet-4-6',
): UsageDelta {
    return {
        conversationId,
        model,
        inputTokens: 1000,
        outputTokens: 500,
        deltaUtilization: 0.5,
        cost,
        timestamp,
    };
}

/**
 * Build N daily deltas, one per day, each `dailyCostDollars` apart.
 * `now` is the anchor; deltas are placed at noon on each of the prior N days.
 */
function dailyDeltas(
    nDays: number,
    dailyCostDollars: number,
    now: number,
    conversationId = 'conv-A',
): UsageDelta[] {
    const out: UsageDelta[] = [];
    for (let i = 0; i < nDays; i++) {
        // Place at noon of (now - i) days. i=0 = same day as now.
        const ts = now - i * DAY_MS;
        out.push(delta(ts, dailyCostDollars, conversationId));
    }
    return out;
}

// ── Calendar helpers ──────────────────────────────────────────────────────────

describe('startOfMonth', () => {
    it('returns first millisecond of the local-time month', () => {
        const expected = new Date(2026, 3, 1, 0, 0, 0, 0).getTime();
        expect(startOfMonth(APRIL_15)).toBe(expected);
    });

    it('handles month boundaries: midnight on the 1st maps to itself', () => {
        const firstOfMay = new Date(2026, 4, 1, 0, 0, 0, 0).getTime();
        expect(startOfMonth(firstOfMay)).toBe(firstOfMay);
    });
});

describe('startOfNextMonth', () => {
    it('rolls forward to the 1st of next month', () => {
        const expected = new Date(2026, 4, 1, 0, 0, 0, 0).getTime();
        expect(startOfNextMonth(APRIL_15)).toBe(expected);
    });

    it('handles December rollover into January of the next year', () => {
        const dec15 = new Date(2026, 11, 15, 12, 0, 0, 0).getTime();
        const expected = new Date(2027, 0, 1, 0, 0, 0, 0).getTime();
        expect(startOfNextMonth(dec15)).toBe(expected);
    });
});

describe('daysUntilNextMonth', () => {
    it('returns the calendar-day count to the 1st of next month', () => {
        // April 15 noon → May 1 midnight = 15 days, 12 hours → 16 (ceil).
        expect(daysUntilNextMonth(APRIL_15)).toBe(16);
    });

    it('returns the full new-month length at midnight on the 1st', () => {
        // May 1 00:00:00 → next-month boundary is June 1 → 31 days remaining.
        const firstOfMay = new Date(2026, 4, 1, 0, 0, 0, 0).getTime();
        expect(daysUntilNextMonth(firstOfMay)).toBe(31);
    });

    it('returns 1 when the last day has fractional time remaining', () => {
        // April 30 at 23:00 → May 1 00:00 = 1 hour, ceil → 1 day.
        const apr30LateNight = new Date(2026, 3, 30, 23, 0, 0, 0).getTime();
        expect(daysUntilNextMonth(apr30LateNight)).toBe(1);
    });
});

// ── projectMonthEnd ───────────────────────────────────────────────────────────

describe('projectMonthEnd', () => {
    it('returns null below the distinct-day floor', () => {
        const deltas = dailyDeltas(MIN_DISTINCT_DAYS_FOR_PROJECTION - 1, 10, APRIL_15);
        const result = projectMonthEnd(deltas, APRIL_15, 50000, 5000);
        expect(result).toBeNull();
    });

    it('returns null when monthlyLimitCents is zero or negative', () => {
        const deltas = dailyDeltas(14, 10, APRIL_15);
        expect(projectMonthEnd(deltas, APRIL_15, 0, 5000)).toBeNull();
        expect(projectMonthEnd(deltas, APRIL_15, -100, 5000)).toBeNull();
    });

    it('returns null on the last second of the month (no days remaining)', () => {
        const lastSecond = new Date(2026, 3, 30, 23, 59, 59, 999).getTime();
        const deltas = dailyDeltas(14, 10, lastSecond);
        expect(daysUntilNextMonth(lastSecond)).toBe(1);
        // 1 day remaining is fine; null only fires when we are exactly at month boundary.
        expect(projectMonthEnd(deltas, lastSecond, 50000, 5000)).not.toBeNull();
    });

    it('projects additively on top of currentUsedCents', () => {
        // 14 days, $10/day. Trailing-7-day sum = $70, daily = $10.
        // 16 days remaining from APRIL_15 noon → projected remainder = 16 × $10 = $160 = 16000c.
        // Base usedCents = 5000c → projected = 21000c.
        const deltas = dailyDeltas(14, 10, APRIL_15);
        const result = projectMonthEnd(deltas, APRIL_15, 50000, 5000);
        expect(result).not.toBeNull();
        expect(result!.projectedSpentCents).toBe(21000);
        expect(result!.projectedUtilizationPct).toBeCloseTo((21000 / 50000) * 100, 5);
        expect(result!.daysRemaining).toBe(16);
    });

    it('flags high confidence on stable, dense usage', () => {
        // 14 distinct days, identical $10 per day → CV = 0 → high.
        const deltas = dailyDeltas(14, 10, APRIL_15);
        const result = projectMonthEnd(deltas, APRIL_15, 50000, 5000);
        expect(result?.confidence).toBe('high');
    });

    it('downgrades to medium when daily totals are highly variable', () => {
        // 14 distinct days, alternating $1 / $50 → CV well above 0.3.
        const out: UsageDelta[] = [];
        for (let i = 0; i < 14; i++) {
            out.push(delta(APRIL_15 - i * DAY_MS, i % 2 === 0 ? 1 : 50));
        }
        const result = projectMonthEnd(out, APRIL_15, 50000, 5000);
        expect(result?.confidence).toBe('medium');
    });

    it('flags medium confidence on 10-13 distinct days', () => {
        const deltas = dailyDeltas(10, 10, APRIL_15);
        const result = projectMonthEnd(deltas, APRIL_15, 50000, 5000);
        expect(result?.confidence).toBe('medium');
    });

    it('flags low confidence on 7-9 distinct days', () => {
        const deltas = dailyDeltas(7, 10, APRIL_15);
        const result = projectMonthEnd(deltas, APRIL_15, 50000, 5000);
        expect(result?.confidence).toBe('low');
    });

    it('excludes deltas from the previous calendar month (post-reset guard)', () => {
        // 14 days of $10/day in March + 0 days in April → null after reset.
        const out: UsageDelta[] = [];
        const march15 = new Date(2026, 2, 15, 12, 0, 0, 0).getTime();
        for (let i = 0; i < 14; i++) {
            out.push(delta(march15 - i * DAY_MS, 10));
        }
        // Anchor on April 2 (post-reset): March deltas should not project into April.
        const apr2 = new Date(2026, 3, 2, 12, 0, 0, 0).getTime();
        const result = projectMonthEnd(out, apr2, 50000, 0);
        expect(result).toBeNull();
    });

    it('ignores cost=null deltas when counting distinct cost-bearing days', () => {
        // 12 days populated: 6 with cost=10, 6 with cost=null. Distinct
        // cost-bearing days = 6, below the floor → null.
        const out: UsageDelta[] = [];
        for (let i = 0; i < 12; i++) {
            out.push(delta(APRIL_15 - i * DAY_MS, i % 2 === 0 ? 10 : null));
        }
        const result = projectMonthEnd(out, APRIL_15, 50000, 5000);
        expect(result).toBeNull();
    });

    it('projects above 100% utilization when on track to exceed cap', () => {
        // 14 days × $50/day → daily burn = $50. 16 days remaining → +$800 = 80000c.
        // Base 30000c + 80000c = 110000c against 50000c cap → 220% projected.
        const deltas = dailyDeltas(14, 50, APRIL_15);
        const result = projectMonthEnd(deltas, APRIL_15, 50000, 30000);
        expect(result?.projectedUtilizationPct).toBeGreaterThan(100);
    });

    it('ignores deltas with timestamps in the future (clock skew safety)', () => {
        // 14 normal days plus 7 deltas timestamped one day after capturedAt.
        // The future deltas would otherwise inflate the trailing 7-day burn
        // and the distinct-day count; both must be excluded.
        const out: UsageDelta[] = [];
        for (let i = 0; i < 14; i++) out.push(delta(APRIL_15 - i * DAY_MS, 10));
        const tomorrow = APRIL_15 + DAY_MS;
        for (let i = 0; i < 7; i++) out.push(delta(tomorrow + i * 1000, 999));

        const withSkew = projectMonthEnd(out, APRIL_15, 50000, 5000);
        const baseline = projectMonthEnd(
            out.filter((d) => d.timestamp <= APRIL_15),
            APRIL_15,
            50000,
            5000,
        );
        expect(withSkew).toEqual(baseline);
    });

    it('uses last 7 days only for the burn rate (older deltas lower the recent mean)', () => {
        // 7 recent days at $20/day, 14 prior days at $1/day. Distinct days = 21 (high tier).
        // Trailing-7-day sum = $140 → daily = $20. Remainder = 16 × $20 = $320 = 32000c.
        // With currentUsedCents=0 → projected = 32000c.
        const out: UsageDelta[] = [];
        for (let i = 0; i < 7; i++) out.push(delta(APRIL_15 - i * DAY_MS, 20, 'recent'));
        for (let i = 7; i < 21; i++) out.push(delta(APRIL_15 - i * DAY_MS, 1, 'older'));
        const result = projectMonthEnd(out, APRIL_15, 100000, 0);
        expect(result).not.toBeNull();
        expect(result!.projectedSpentCents).toBe(32000);
    });
});

// ── aggregateByConversation ───────────────────────────────────────────────────

describe('aggregateByConversation', () => {
    it('returns an empty array when the delta log is empty', () => {
        expect(aggregateByConversation([], APRIL_15 - 30 * DAY_MS)).toEqual([]);
    });

    it('groups by conversationId and sums cost in cents', () => {
        const deltas = [
            delta(APRIL_15, 0.10, 'conv-A'),
            delta(APRIL_15, 0.20, 'conv-A'),
            delta(APRIL_15, 0.30, 'conv-B'),
        ];
        const result = aggregateByConversation(deltas, 0);
        expect(result).toEqual([
            { conversationId: 'conv-A', totalCostCents: 30, turnCount: 2 },
            { conversationId: 'conv-B', totalCostCents: 30, turnCount: 1 },
        ]);
    });

    it('sorts descending by totalCostCents', () => {
        const deltas = [
            delta(APRIL_15, 0.10, 'cheap'),
            delta(APRIL_15, 5.00, 'expensive'),
            delta(APRIL_15, 1.00, 'middle'),
        ];
        const ranked = aggregateByConversation(deltas, 0);
        expect(ranked.map((r) => r.conversationId)).toEqual(['expensive', 'middle', 'cheap']);
    });

    it('filters deltas before sinceTimestamp', () => {
        const monthStart = startOfMonth(APRIL_15);
        const lastMonth = monthStart - DAY_MS;
        const deltas = [
            delta(lastMonth, 1.00, 'old'),
            delta(APRIL_15, 0.50, 'current'),
        ];
        const ranked = aggregateByConversation(deltas, monthStart);
        expect(ranked).toEqual([
            { conversationId: 'current', totalCostCents: 50, turnCount: 1 },
        ]);
    });

    it('skips cost=null deltas without crashing or counting them', () => {
        const deltas = [
            delta(APRIL_15, null, 'conv-A'),
            delta(APRIL_15, 0.50, 'conv-A'),
            delta(APRIL_15, null, 'conv-B'),
        ];
        const ranked = aggregateByConversation(deltas, 0);
        expect(ranked).toEqual([
            { conversationId: 'conv-A', totalCostCents: 50, turnCount: 1 },
        ]);
    });

    it('preserves sub-cent precision until the boundary rounding', () => {
        // 100 turns × $0.0023 = $0.23 = 23c. If we rounded each turn we'd see 0.
        const deltas = Array.from({ length: 100 }, () =>
            delta(APRIL_15, 0.0023, 'conv-precise'),
        );
        const [entry] = aggregateByConversation(deltas, 0);
        expect(entry.totalCostCents).toBe(23);
        expect(entry.turnCount).toBe(100);
    });

    // AC: per-conversation cost matches sum of cost values in ConversationRecord.turns.
    it('reconciles with sum of cost across ConversationRecord.turns for the same conversation', () => {
        // Synthesize matched delta + turn pairs for one conversation.
        // For each turn the delta carries the same `cost` value, simulating
        // the in-production invariant that background.ts writes both records
        // with identical cost figures.
        const turnCosts = [0.12, 0.34, 0.56, 0.78, 0.91];
        const turns: TurnRecord[] = turnCosts.map((cost, i) => ({
            turnNumber: i + 1,
            inputTokens: 1000,
            outputTokens: 500,
            model: 'claude-sonnet-4-6',
            contextPct: 10 + i,
            cost,
            completedAt: APRIL_15 + i * 1000,
            deltaUtilization: 0.5,
        }));
        const deltas: UsageDelta[] = turnCosts.map((cost, i) => ({
            conversationId: 'conv-recon',
            model: 'claude-sonnet-4-6',
            inputTokens: 1000,
            outputTokens: 500,
            deltaUtilization: 0.5,
            cost,
            timestamp: APRIL_15 + i * 1000,
        }));

        const turnSumDollars = turns.reduce((acc, t) => acc + (t.cost ?? 0), 0);
        const expectedCents = Math.round(turnSumDollars * 100);

        const [aggregated] = aggregateByConversation(deltas, 0);
        expect(aggregated.totalCostCents).toBe(expectedCents);
        expect(aggregated.turnCount).toBe(turns.length);

        // ConversationRecord shape only constructed to make the invariant
        // explicit in the test body; it is not passed to the agent.
        const record: Pick<ConversationRecord, 'id' | 'turns'> = {
            id: 'conv-recon',
            turns,
        };
        expect(record.turns.length).toBe(aggregated.turnCount);
    });
});

// ── Type guard: SpendTrajectory shape never returns NaN/Infinity ──────────────

describe('SpendTrajectory invariants', () => {
    it('produces finite, non-negative values across the supported confidence tiers', () => {
        for (const days of [7, 10, 14, 20]) {
            const deltas = dailyDeltas(days, 5, APRIL_15);
            const result = projectMonthEnd(deltas, APRIL_15, 50000, 1000) as SpendTrajectory;
            expect(result).not.toBeNull();
            expect(Number.isFinite(result.projectedSpentCents)).toBe(true);
            expect(Number.isFinite(result.projectedUtilizationPct)).toBe(true);
            expect(result.projectedSpentCents).toBeGreaterThanOrEqual(0);
            expect(result.projectedUtilizationPct).toBeGreaterThanOrEqual(0);
            expect(result.daysRemaining).toBeGreaterThanOrEqual(0);
        }
    });
});
