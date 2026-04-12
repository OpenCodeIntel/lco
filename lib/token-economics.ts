// lib/token-economics.ts
// Pure agent: derives median tokens-per-1% of 5-hour session limit, grouped by model.
//
// Architecture position: lib/ agent layer. Pure functions only — no DOM, no chrome.*, no storage.
// Input:  UsageDelta[] from getUsageDeltas() in lib/conversation-store.ts
// Output: TokenEconomicsResult (two Maps keyed by model string)
// Called by: nothing at runtime yet. Exists for LCO-35 (pre-submit intelligence)
//            and LCO-36 (efficiency score). Wire it in the content script when those ship.
//
// Why this exists: each model consumes session limit at a different rate. Knowing the
// median tokens-per-1% lets us predict how much session a draft message will cost before
// the user sends it, and flag conversations that are burning limit faster than expected.

import type { UsageDelta } from './conversation-store';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Output of computeTokenEconomics.
 * Both Maps are keyed by model name (e.g. "claude-sonnet-4-6").
 * A model is only present when it has at least MIN_SAMPLES valid delta records.
 */
export interface TokenEconomicsResult {
    /**
     * Median total tokens (input + output) consumed per 1% of session limit,
     * per model. Higher = less efficient per session percentage point.
     */
    medianTokensPer1Pct: Map<string, number>;
    /** Number of delta records used to compute the median for each model. */
    sampleSize: Map<string, number>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum number of valid delta records required before reporting a median.
 * Below this threshold, the sample is too small to be representative.
 * 5 is the minimum for a meaningful median with odd-count middle selection.
 */
export const MIN_SAMPLES = 5;

// ── Pure utility ──────────────────────────────────────────────────────────────

/**
 * Compute the median of an array of numbers.
 * For an odd count, returns the middle value.
 * For an even count, returns the average of the two middle values.
 * The array must be non-empty; callers are responsible for the MIN_SAMPLES gate.
 */
function median(sorted: number[]): number {
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[mid];
    }
    return (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Derive the median tokens-per-1% of session limit for each model.
 *
 * Algorithm:
 *   1. Exclude records where deltaUtilization === 0 (no session consumed; division
 *      would produce Infinity and skew the median).
 *   2. Group by model. For each record, compute:
 *        tokensPerPct = (inputTokens + outputTokens) / deltaUtilization
 *   3. Skip models with fewer than MIN_SAMPLES valid records.
 *   4. Sort each model's values ascending and take the median.
 *
 * @param deltas - Array of UsageDelta records, typically from getUsageDeltas().
 *                 Only records with deltaUtilization > 0 contribute to the result.
 * @returns TokenEconomicsResult with Maps keyed by model string.
 *          Models below MIN_SAMPLES are absent from both Maps.
 */
export function computeTokenEconomics(deltas: UsageDelta[]): TokenEconomicsResult {
    // Group tokensPerPct values by model, excluding zero-delta records.
    const byModel = new Map<string, number[]>();

    for (const delta of deltas) {
        if (delta.deltaUtilization === 0) continue;
        const tokensPerPct = (delta.inputTokens + delta.outputTokens) / delta.deltaUtilization;
        const bucket = byModel.get(delta.model) ?? [];
        bucket.push(tokensPerPct);
        byModel.set(delta.model, bucket);
    }

    const medianTokensPer1Pct = new Map<string, number>();
    const sampleSize = new Map<string, number>();

    for (const [model, values] of byModel) {
        if (values.length < MIN_SAMPLES) continue;
        values.sort((a, b) => a - b);
        medianTokensPer1Pct.set(model, median(values));
        sampleSize.set(model, values.length);
    }

    return { medianTokensPer1Pct, sampleSize };
}
