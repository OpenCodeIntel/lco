// lib/usage-budget.ts - Usage Budget Agent (7th agent in the multi-agent architecture)
//
// Responsibility: transform raw usage limit data from Anthropic's endpoint into
// a structured, display-ready result for the side panel dashboard.
//
// Where it fits:
//   Data source: /api/organizations/{orgId}/usage (fetched by content script)
//   Storage key: usageLimits:{accountId} in chrome.storage.local
//   Caller: useDashboardData.ts reads storage and calls computeUsageBudget()
//   Consumer: UsageBudgetCard.tsx renders the result
//
// Tier dispatch:
//   The endpoint exposes a different shape per account tier (see
//   lib/usage-limits-parser.ts). This agent branches on `limits.kind` and
//   returns the matching UsageBudgetResult variant. Render code never
//   computes its own status text or zone: every label that ends up on the
//   user's screen comes from here.
//
// Design principles (mirrors all other lib/ agents):
//   - Pure functions only. No DOM, no chrome.*, no side effects.
//   - Typed input, typed output. No implicit any.
//   - Every value is derived from exact Anthropic data: no estimation, no guessing.
//   - If the data is unavailable, the result says so clearly via the kind.

import type {
    UsageLimitsData,
    UsageBudgetResult,
    UsageBudgetSession,
    UsageBudgetCredit,
    BudgetZone,
} from './message-types';
import { formatCurrencyCents } from './format';

// ── Zone classification ───────────────────────────────────────────────────────

// Thresholds match Saar's health-score conventions: comfortable below half,
// critical above 90%. The zone drives color coding: green → yellow → orange → red.
const ZONE_MODERATE_THRESHOLD = 50;   // percentage
const ZONE_TIGHT_THRESHOLD = 75;      // percentage
const ZONE_CRITICAL_THRESHOLD = 90;   // percentage

/**
 * Classify a utilization percentage into a display zone.
 * comfortable: <50% | moderate: 50-74% | tight: 75-89% | critical: >=90%
 * Exported so UI components can color individual bars (e.g. the weekly bar
 * in UsageBudgetCard) using the same thresholds as the agent.
 */
export function classifyZone(pct: number): BudgetZone {
    if (pct >= ZONE_CRITICAL_THRESHOLD) return 'critical';
    if (pct >= ZONE_TIGHT_THRESHOLD)    return 'tight';
    if (pct >= ZONE_MODERATE_THRESHOLD) return 'moderate';
    return 'comfortable';
}

// ── Reset countdown ───────────────────────────────────────────────────────────

/**
 * Minutes until a given ISO 8601 reset timestamp. Floored at 0 (never negative).
 * Input: ISO string from Anthropic (e.g. "2026-04-07T01:00:01.321075+00:00")
 * Output: whole minutes remaining (e.g. 53)
 */
function minutesUntilReset(resetsAt: string, now: number): number {
    const resetMs = new Date(resetsAt).getTime();
    const diffMs = resetMs - now;
    return Math.max(0, Math.floor(diffMs / 60000));
}

/**
 * Format minutes into a compact human-readable string.
 * < 60 min: "53 min"  |  >= 60 min: "1h 12m"  |  0: "now"
 */
function formatMinutes(minutes: number): string {
    if (minutes <= 0) return 'now';
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ── Weekly reset label ────────────────────────────────────────────────────────

/**
 * Format a weekly reset timestamp as a short day + time label.
 * Uses the browser's locale for hour formatting (12/24h as the user expects).
 * Output examples: "Wed 9:00 AM", "Thu 14:00"
 */
function formatWeeklyResetLabel(resetsAt: string): string {
    const date = new Date(resetsAt);
    // Intl.DateTimeFormat: weekday short + hour + minute, no date, no year.
    return new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
    }).format(date);
}

// ── Status label ─────────────────────────────────────────────────────────────

/**
 * Build the one-liner primary text for the UsageBudgetCard (session variant).
 * Session is the more urgent window (resets every 5 hours), so it leads.
 * Examples:
 *   comfortable: "11% used; resets in 53 min"
 *   moderate:    "62% used; resets in 2h 15m"
 *   tight:       "82% used; resets in 23 min"
 *   critical:    "94% used; session nearly exhausted"
 */
function buildSessionStatusLabel(sessionPct: number, sessionMinutes: number, zone: BudgetZone): string {
    const pctStr = `${Math.round(sessionPct)}% used`;
    if (zone === 'critical') {
        return `${pctStr}; session nearly exhausted`;
    }
    const countdown = formatMinutes(sessionMinutes);
    return `${pctStr}; resets in ${countdown}`;
}

// ── Credit-tier helpers ──────────────────────────────────────────────────────

/**
 * "Resets May 1": first day of the next calendar month, locale-formatted.
 * Anthropic resets Enterprise credit pools on the first of the month, so the
 * label is deterministic from `now` alone; the endpoint does not return a
 * resets_at for credit responses.
 */
function buildCreditResetLabel(now: number): string {
    const today = new Date(now);
    // First-of-next-month in the user's local calendar. Date math handles year
    // rollover automatically (December 1 → January 1).
    const reset = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const formatted = new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
    }).format(reset);
    return `Resets ${formatted}`;
}

// ── Main agent function ───────────────────────────────────────────────────────

/**
 * Transform raw Anthropic usage data into a display-ready budget result.
 *
 * Branches on `limits.kind`:
 *   - 'session'     → session windows + zone from max(session, weekly) + status text
 *   - 'credit'      → monthly spend + zone from utilizationPct + "$X of $Y spent"
 *   - 'unsupported' → passthrough; the card renders a "not supported" message
 *
 * @param limits  - Parsed response from /api/organizations/{orgId}/usage
 * @param now     - Current Unix ms timestamp (injectable for testability)
 */
export function computeUsageBudget(limits: UsageLimitsData, now: number): UsageBudgetResult {
    if (limits.kind === 'session') {
        const sessionPct = limits.fiveHour.utilization;
        const weeklyPct = limits.sevenDay.utilization;

        // Zone is driven by whichever window is more exhausted.
        const zone = classifyZone(Math.max(sessionPct, weeklyPct));

        const sessionMinutesUntilReset = minutesUntilReset(limits.fiveHour.resetsAt, now);
        const weeklyResetLabel = formatWeeklyResetLabel(limits.sevenDay.resetsAt);
        const statusLabel = buildSessionStatusLabel(sessionPct, sessionMinutesUntilReset, zone);

        const result: UsageBudgetSession = {
            kind: 'session',
            sessionPct,
            weeklyPct,
            sessionMinutesUntilReset,
            weeklyResetLabel,
            zone,
            statusLabel,
        };
        return result;
    }

    if (limits.kind === 'credit') {
        const zone = classifyZone(limits.utilizationPct);
        const spent = formatCurrencyCents(limits.usedCents, limits.currency);
        const total = formatCurrencyCents(limits.monthlyLimitCents, limits.currency);
        const result: UsageBudgetCredit = {
            kind: 'credit',
            monthlyLimitCents: limits.monthlyLimitCents,
            usedCents: limits.usedCents,
            utilizationPct: limits.utilizationPct,
            currency: limits.currency,
            resetLabel: buildCreditResetLabel(now),
            zone,
            statusLabel: `${spent} of ${total} spent`,
        };
        return result;
    }

    // Unsupported account type: nothing to compute. The card branches on this
    // kind and renders an explicit "can't read this account" message.
    return { kind: 'unsupported' };
}

// ── Delta tracking helper ─────────────────────────────────────────────────────

/**
 * Return the percentage value the content script should track turn-over-turn
 * for delta computation. Session tier tracks the 5-hour window; credit tier
 * tracks monthly utilization. The label changes (% of session vs % of monthly)
 * but the math is the same: subtract before from after to get the cost of one
 * message in tier-appropriate units.
 *
 * Typed to reject the unsupported variant: there is nothing to track when the
 * endpoint shape was unrecognized, and forcing the caller to gate first keeps
 * the helper itself total.
 */
export function getTrackedUtilization(budget: UsageBudgetSession | UsageBudgetCredit): number {
    return budget.kind === 'session' ? budget.sessionPct : budget.utilizationPct;
}
