// lib/spend-trajectory.ts
// Spend Trajectory Agent — projects month-end spend for credit-tier (Enterprise)
// accounts and ranks the most expensive conversations of the current month.
//
// Pure functions only. No DOM refs, no chrome.* calls, no side effects.
// Callers: useDashboardData.ts (side panel, credit-tier render path only).
// Storage owned by: conversation-store.ts (appendUsageDelta etc).
//
// Why this exists:
//   Anthropic restructured Enterprise pricing on 2026-04-16: bundled tokens
//   were removed from the seat fee and usage now bills at API rates separately.
//   The Admin API does not expose per-conversation breakdowns and requires an
//   admin key individuals may not have. Saar projects month-end spend from the
//   locally-tracked delta log instead, and ranks conversations by cost.
//
// Two exports:
//   projectMonthEnd        — additive projection on top of the exact
//                            currentUsedCents from the Anthropic endpoint.
//   aggregateByConversation — pure grouping; ranked descending by cost.

import type { UsageDelta } from './conversation-store';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpendTrajectory {
    /** Projected month-end spend in cents (currentUsedCents + extrapolated remainder). */
    projectedSpentCents: number;
    /** projectedSpentCents as a percentage of monthlyLimitCents. May exceed 100. */
    projectedUtilizationPct: number;
    /** Calendar days from `capturedAt` to the first of next month. Floored at 0. */
    daysRemaining: number;
    /**
     * Signal-quality label, drives copy variation in the card:
     *   high   — n ≥ 14 distinct cost-bearing days AND CV < 0.3
     *   medium — n ≥ 10 distinct cost-bearing days
     *   low    — n ≥  7 distinct cost-bearing days
     * Below 7 distinct days projectMonthEnd returns null entirely
     * (the card renders a "need more data" placeholder).
     */
    confidence: 'low' | 'medium' | 'high';
}

export interface ConversationSpend {
    conversationId: string;
    /** Sum of delta costs for the conversation, rounded to integer cents at the boundary. */
    totalCostCents: number;
    /** Count of cost-bearing delta records contributing to totalCostCents. */
    turnCount: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum distinct cost-bearing days in the current month before projecting. */
export const MIN_DISTINCT_DAYS_FOR_PROJECTION = 7;

/** Distinct-day thresholds for the confidence classifier. */
const HIGH_CONF_DISTINCT_DAYS = 14;
const MEDIUM_CONF_DISTINCT_DAYS = 10;

/** Coefficient-of-variation ceiling for high-confidence promotion. */
const HIGH_CONF_CV_MAX = 0.3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Calendar helpers ──────────────────────────────────────────────────────────

/**
 * Unix ms timestamp at the start of the calendar month containing `now`.
 * Local timezone, matching the user's perception of the "monthly" reset.
 */
export function startOfMonth(now: number): number {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
}

/**
 * Unix ms timestamp at the start of the next calendar month after `now`.
 * Used as the projection target: Anthropic resets Enterprise credit pools
 * on the first of each month.
 */
export function startOfNextMonth(now: number): number {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
}

/**
 * Calendar days remaining from `now` to the first of next month.
 * Counts whole days; a fractional remainder still counts as one day.
 * Floored at 0 — never negative even if the clock skews past month boundary.
 */
export function daysUntilNextMonth(now: number): number {
    const target = startOfNextMonth(now);
    const diffMs = target - now;
    if (diffMs <= 0) return 0;
    return Math.ceil(diffMs / MS_PER_DAY);
}

/** YYYY-MM-DD in local time for grouping deltas into distinct calendar days. */
function dateKey(timestamp: number): string {
    const d = new Date(timestamp);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ── projectMonthEnd ───────────────────────────────────────────────────────────

/**
 * Project month-end spend by adding a 7-day rolling burn-rate extrapolation
 * to the exact `currentUsedCents` reported by Anthropic.
 *
 * Why additive on top of the endpoint rather than recomputed from deltas:
 *   The endpoint figure is exact (matches the user's Settings > Usage page).
 *   The local delta log only sees turns Saar observed; using it as the base
 *   would underreport spend for users who chat without the extension active.
 *   Projection of the remainder uses deltas as a rate proxy only.
 *
 * Returns null when:
 *   - fewer than MIN_DISTINCT_DAYS_FOR_PROJECTION distinct cost-bearing days
 *     in the current calendar month (drives the "need more data" UI)
 *
 * @param deltas             Append-only delta log for the account, oldest first.
 * @param capturedAt         Unix ms timestamp the projection is anchored to.
 * @param monthlyLimitCents  Monthly credit limit in integer cents (from endpoint).
 * @param currentUsedCents   Current month's exact spend in integer cents (from endpoint).
 */
export function projectMonthEnd(
    deltas: UsageDelta[],
    capturedAt: number,
    monthlyLimitCents: number,
    currentUsedCents: number,
): SpendTrajectory | null {
    if (monthlyLimitCents <= 0) return null;

    const monthStart = startOfMonth(capturedAt);

    // Bucket current-month, cost-bearing deltas by calendar day.
    // Sums are kept in dollars (delta.cost units) to preserve sub-cent
    // precision; conversion to integer cents happens once at the end.
    const dailyTotalsDollars = new Map<string, number>();
    for (const delta of deltas) {
        if (delta.timestamp < monthStart || delta.timestamp > capturedAt) continue;
        if (delta.cost === null) continue;
        const key = dateKey(delta.timestamp);
        dailyTotalsDollars.set(key, (dailyTotalsDollars.get(key) ?? 0) + delta.cost);
    }

    const distinctDays = dailyTotalsDollars.size;
    if (distinctDays < MIN_DISTINCT_DAYS_FOR_PROJECTION) return null;

    const daysRemaining = daysUntilNextMonth(capturedAt);

    // 7-day rolling burn rate: sum of the last 7 calendar days of deltas,
    // window (capturedAt - 7d, capturedAt], divided by 7. Days with zero usage
    // in that window count as zero (lowers the mean), which is the honest
    // behavior for a user who pauses Saar. The left edge is strict so a
    // delta at exactly seven days ago does not double-count into a window
    // that already includes its same-day successor.
    const sevenDaysAgo = capturedAt - 7 * MS_PER_DAY;
    let trailingSevenDayDollars = 0;
    for (const delta of deltas) {
        if (delta.timestamp <= sevenDaysAgo || delta.timestamp > capturedAt) continue;
        if (delta.cost === null) continue;
        trailingSevenDayDollars += delta.cost;
    }
    const dailyBurnDollars = trailingSevenDayDollars / 7;
    const dailyBurnCents = dailyBurnDollars * 100;

    const projectedRemainderCents = dailyBurnCents * daysRemaining;
    const projectedSpentCents = Math.round(currentUsedCents + projectedRemainderCents);
    const projectedUtilizationPct = (projectedSpentCents / monthlyLimitCents) * 100;

    // Confidence: distinct-day count gates the tier; coefficient of variation
    // of daily totals decides high vs medium when both day-count thresholds
    // are met. CV is std-dev / mean; a tight CV means the daily burns cluster,
    // which justifies the firmer "On track for…" copy.
    const confidence = classifyConfidence(Array.from(dailyTotalsDollars.values()));

    return {
        projectedSpentCents,
        projectedUtilizationPct,
        daysRemaining,
        confidence,
    };
}

function classifyConfidence(dailyTotals: number[]): 'low' | 'medium' | 'high' {
    const n = dailyTotals.length;
    if (n >= HIGH_CONF_DISTINCT_DAYS) {
        const cv = coefficientOfVariation(dailyTotals);
        if (cv < HIGH_CONF_CV_MAX) return 'high';
        return 'medium';
    }
    if (n >= MEDIUM_CONF_DISTINCT_DAYS) return 'medium';
    return 'low';
}

function coefficientOfVariation(values: number[]): number {
    if (values.length === 0) return Infinity;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean === 0) return Infinity;
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / mean;
}

// ── aggregateByConversation ───────────────────────────────────────────────────

/**
 * Group cost-bearing deltas by conversation and sort descending by total cost.
 * Used by the credit-tier card to surface the most expensive conversations of
 * the current month.
 *
 * @param deltas          Append-only delta log for the account.
 * @param sinceTimestamp  Inclusive lower bound (Unix ms). Pass `startOfMonth(now)`
 *                        to scope to the current calendar month; pass 0 for
 *                        all-time. Deltas with timestamp < sinceTimestamp are
 *                        excluded.
 */
export function aggregateByConversation(
    deltas: UsageDelta[],
    sinceTimestamp: number,
): ConversationSpend[] {
    // Sum costs in dollars to preserve sub-cent precision; round once at output.
    const totals = new Map<string, { dollars: number; turns: number }>();

    for (const delta of deltas) {
        if (delta.timestamp < sinceTimestamp) continue;
        if (delta.cost === null) continue;
        const entry = totals.get(delta.conversationId) ?? { dollars: 0, turns: 0 };
        entry.dollars += delta.cost;
        entry.turns += 1;
        totals.set(delta.conversationId, entry);
    }

    const out: ConversationSpend[] = [];
    for (const [conversationId, { dollars, turns }] of totals) {
        out.push({
            conversationId,
            totalCostCents: Math.round(dollars * 100),
            turnCount: turns,
        });
    }

    out.sort((a, b) => b.totalCostCents - a.totalCostCents);
    return out;
}
