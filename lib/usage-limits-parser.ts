// lib/usage-limits-parser.ts - Tier dispatch for /api/organizations/{orgId}/usage
//
// Anthropic's usage endpoint returns three distinct shapes depending on the
// account tier of the requesting org. There is no `tier` field; we have to
// dispatch by which sub-objects are populated:
//
//   Pro / Personal / Max / Team
//     → `five_hour` and `seven_day` are objects with utilization + resets_at
//     → `extra_usage.is_enabled` is false (or extra_usage is absent)
//
//   Enterprise
//     → `five_hour` and `seven_day` are explicitly null
//     → `extra_usage.is_enabled` is true with monthly_limit / used_credits in cents
//
//   Unrecognized 200 (e.g. some Teams configurations, future tiers)
//     → neither shape is fully populated
//
// Anything that is not JSON, or JSON we cannot recognize at all, falls through
// as `null` so the caller can distinguish "we got something we cannot use yet"
// (which still gives the user a "not supported" empty state) from "the request
// failed" (which keeps the previous render in place).
//
// This module is the only place that touches the raw endpoint shape. Every
// downstream consumer reads typed UsageLimitsData; the wire format does not
// leak past this file.

import type { UsageLimitsData } from './message-types';

// ── Raw endpoint shape (defensive — every field optional) ─────────────────────
// We deliberately type these as `unknown`-friendly: a field may be missing,
// null, or the wrong type. The dispatch helpers below validate what they need.

interface RawUsageWindow {
    utilization?: unknown;
    resets_at?: unknown;
}

interface RawExtraUsage {
    is_enabled?: unknown;
    monthly_limit?: unknown;
    used_credits?: unknown;
    utilization?: unknown;
    currency?: unknown;
}

interface RawUsageResponse {
    five_hour?: RawUsageWindow | null;
    seven_day?: RawUsageWindow | null;
    extra_usage?: RawExtraUsage | null;
}

// ── Type guards ──────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when both windows carry a numeric utilization and a string resets_at.
 * This is the pre-Enterprise shape we have always handled.
 */
function isSessionShape(raw: RawUsageResponse): boolean {
    const five = raw.five_hour;
    const seven = raw.seven_day;
    return (
        isObject(five) &&
        typeof five.utilization === 'number' &&
        typeof five.resets_at === 'string' &&
        isObject(seven) &&
        typeof seven.utilization === 'number' &&
        typeof seven.resets_at === 'string'
    );
}

/**
 * True when extra_usage is enabled with a complete cents-and-utilization payload.
 * We require all four fields because rendering a half-populated bar would be
 * worse than rendering the unsupported empty state.
 */
function isCreditShape(raw: RawUsageResponse): boolean {
    const extra = raw.extra_usage;
    return (
        isObject(extra) &&
        extra.is_enabled === true &&
        typeof extra.monthly_limit === 'number' &&
        typeof extra.used_credits === 'number' &&
        typeof extra.utilization === 'number' &&
        typeof extra.currency === 'string'
    );
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a raw /api/organizations/{orgId}/usage response into typed UsageLimitsData.
 *
 * Returns:
 *   - { kind: 'session', ... }     for the Pro/Personal/Max/Team window shape
 *   - { kind: 'credit', ... }      for the Enterprise extra_usage shape
 *   - { kind: 'unsupported', ... } when the response is a recognizable object
 *                                   but neither shape applies (renders an
 *                                   explicit "can't read this account" state)
 *   - null                          when the input is not even an object we can
 *                                   inspect (treat as transient failure; caller
 *                                   leaves any previous render in place)
 *
 * Session takes priority over credit if both shapes happen to be populated.
 * On every observed account so far, exactly one of the two is present, but we
 * still pick a winner so the function is total.
 */
export function parseUsageResponse(json: unknown): UsageLimitsData | null {
    if (!isObject(json)) return null;
    const raw = json as RawUsageResponse;
    const capturedAt = Date.now();

    if (isSessionShape(raw)) {
        // Non-null assertions are safe: isSessionShape proved both windows
        // exist with the right primitive types.
        const five = raw.five_hour as { utilization: number; resets_at: string };
        const seven = raw.seven_day as { utilization: number; resets_at: string };
        return {
            kind: 'session',
            fiveHour: { utilization: five.utilization, resetsAt: five.resets_at },
            sevenDay: { utilization: seven.utilization, resetsAt: seven.resets_at },
            capturedAt,
        };
    }

    if (isCreditShape(raw)) {
        const extra = raw.extra_usage as {
            monthly_limit: number;
            used_credits: number;
            utilization: number;
            currency: string;
        };
        return {
            kind: 'credit',
            monthlyLimitCents: extra.monthly_limit,
            usedCents: extra.used_credits,
            utilizationPct: extra.utilization,
            currency: extra.currency,
            capturedAt,
        };
    }

    return { kind: 'unsupported', capturedAt };
}
