// lib/weekly-cap-eta.ts
// Weekly Cap ETA Agent — projects when a Pro/Max user will exhaust their 7-day
// rolling usage window given a rolling list of timestamped weeklyPct snapshots.
//
// Pure functions only. No DOM refs, no chrome.* calls, no side effects.
// Callers: useDashboardData.ts (side panel), claude-ai.content.ts (overlay).
// Storage managed by: conversation-store.ts (appendUsageBudgetSnapshot etc).
//
// Algorithm: least-squares linear fit on (timestamp, weeklyPct) pairs.
//   slope = rate of weekly utilization growth in % per ms
//   ETA   = (100 - intercept) / slope → Unix ms when projection hits 100%
//   R²    = 1 − SSres/SStot → goodness-of-fit, drives confidence label

export interface UsageBudgetSnapshot {
    /** Unix ms timestamp of when this snapshot was captured. */
    timestamp: number;
    /** 7-day rolling utilization percentage (0-100) at capture time. */
    weeklyPct: number;
    /** 5-hour session utilization percentage (0-100) at capture time. */
    sessionPct: number;
}

export interface WeeklyEta {
    /** Unix ms timestamp when the linear projection hits 100%. */
    etaTimestamp: number;
    /** Hours until 100% at the current rate. Always > 0 when returned. */
    hoursRemaining: number;
    /**
     * Signal-quality label:
     *   high   — n ≥ 10 AND R² ≥ 0.9 → show precise ETA
     *   medium — n ≥  7 AND R² ≥ 0.7 → show ETA with "estimated" qualifier
     *   low    — n ≥  5, lower fit    → show ETA with "need more data" note
     */
    confidence: 'low' | 'medium' | 'high';
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum snapshots needed to produce any ETA. Fewer → null. */
export const MIN_SNAPSHOTS_FOR_ETA = 5;

/** If (max - min) weeklyPct < this threshold over a span >= FLAT_DURATION_MS → flat → null. */
const FLAT_RANGE_THRESHOLD = 10;

/** Minimum time span before a small pct range is treated as definitively flat. */
const FLAT_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/** ETAs more than one week away are suppressed: the window resets in 7 days anyway. */
const MAX_ETA_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;

// ── Confidence ────────────────────────────────────────────────────────────────

function classifyConfidence(n: number, r2: number): 'low' | 'medium' | 'high' {
    if (n >= 10 && r2 >= 0.9) return 'high';
    if (n >= 7 && r2 >= 0.7) return 'medium';
    return 'low';
}

// ── ETA formatting ─────────────────────────────────────────────────────────────

/**
 * Format a Unix ms ETA as a short day-plus-time label using the browser's
 * locale settings. Examples: "Wed 6:30 PM", "Thu 14:00".
 * Exported so the card and the overlay can both format consistently.
 */
export function formatEtaLabel(etaTimestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
    }).format(new Date(etaTimestamp));
}

// ── Main agent function ───────────────────────────────────────────────────────

/**
 * Project when the weekly utilization will reach 100% using a least-squares
 * linear fit on the provided snapshot list.
 *
 * Returns null when:
 *   - fewer than MIN_SNAPSHOTS_FOR_ETA entries exist
 *   - the fitted slope is <= 0 (flat or declining usage)
 *   - the range across a 24h+ span is < FLAT_RANGE_THRESHOLD (definitively flat)
 *   - the projected ETA is in the past or beyond MAX_ETA_LOOKAHEAD_MS
 *
 * @param snapshots - Rolling list of usage snapshots (may be unsorted).
 * @param now       - Current Unix ms timestamp (injectable for testability).
 */
export function computeWeeklyEta(
    snapshots: UsageBudgetSnapshot[],
    now: number,
): WeeklyEta | null {
    if (snapshots.length < MIN_SNAPSHOTS_FOR_ETA) return null;

    // Sort ascending by timestamp for all subsequent math.
    const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
    const n = sorted.length;

    const first = sorted[0];
    const last = sorted[n - 1];

    // Flatness guard: a long observation window with a tiny utilization range
    // indicates no meaningful growth, regardless of numeric slope.
    const span = last.timestamp - first.timestamp;
    const minPct = Math.min(...sorted.map(s => s.weeklyPct));
    const maxPct = Math.max(...sorted.map(s => s.weeklyPct));
    if (span >= FLAT_DURATION_MS && (maxPct - minPct) < FLAT_RANGE_THRESHOLD) return null;

    // Least-squares linear fit: minimize sum of squared residuals.
    // y = slope * x + intercept  (x: ms timestamp, y: weeklyPct)
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const s of sorted) {
        sumX += s.timestamp;
        sumY += s.weeklyPct;
        sumXY += s.timestamp * s.weeklyPct;
        sumXX += s.timestamp * s.timestamp;
    }

    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null;

    const slope = (n * sumXY - sumX * sumY) / denom; // pct / ms
    if (slope <= 0) return null;

    const intercept = (sumY - slope * sumX) / n;

    // Project to 100%: t = (100 - intercept) / slope
    const etaTimestamp = (100 - intercept) / slope;
    const msRemaining = etaTimestamp - now;

    // Reject past ETAs and far-future projections (cap window resets weekly anyway).
    if (msRemaining <= 0 || msRemaining > MAX_ETA_LOOKAHEAD_MS) return null;

    const hoursRemaining = msRemaining / (60 * 60 * 1000);

    // R²: coefficient of determination. Measures how well the linear model fits.
    // 1.0 = perfect fit; 0.0 = model explains nothing (noise).
    const meanY = sumY / n;
    let ssRes = 0;
    let ssTot = 0;
    for (const s of sorted) {
        const predicted = slope * s.timestamp + intercept;
        ssRes += (s.weeklyPct - predicted) ** 2;
        ssTot += (s.weeklyPct - meanY) ** 2;
    }
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

    return {
        etaTimestamp,
        hoursRemaining,
        confidence: classifyConfidence(n, r2),
    };
}
