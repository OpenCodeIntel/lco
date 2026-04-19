// lib/health-score.ts
// Pure function: conversation metadata -> human-readable health assessment.
// No DOM refs, no chrome APIs, no side effects.
//
// The health score replaces raw "73% ctx" with a three-state indicator
// (Healthy / Degrading / Critical) and a one-line coaching message that
// tells the user exactly what is happening and what to do about it.
//
// Based on the Chroma context rot research (2025): every frontier LLM
// shows a U-shaped attention curve. Models attend strongly to the beginning
// and end of context, and poorly to the middle. Performance degrades as
// context grows, especially past 50% utilization with high turn counts.

// ── Types ─────────────────────────────────────────────────────────────────────

export type HealthLevel = 'healthy' | 'degrading' | 'critical';

export interface HealthScore {
    level: HealthLevel;
    /** One-line human-readable explanation. Shown in the overlay. */
    label: string;
    /** Actionable coaching text. Shown below the indicator. */
    coaching: string;
    /** Raw context utilization percentage (0-100), passed through for the bar. */
    contextPct: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Context thresholds (percentage of context window).
export const HEALTHY_CEIL = 70;
export const DEGRADING_CEIL = 90;

// Turn count thresholds. High turn count amplifies context rot.
export const TURN_HEALTHY_CEIL = 10;
export const TURN_DEGRADING_CEIL = 20;
export const TURN_CRITICAL_CEIL = 30;

// Growth rate threshold (% per turn). Fast-filling conversations degrade sooner.
export const FAST_GROWTH_PCT = 8;

// ── Score computation ─────────────────────────────────────────────────────────

export interface HealthInput {
    contextPct: number;     // 0-100
    turnCount: number;
    growthRate: number | null;  // avg % per turn, null if insufficient data
}

/**
 * Compute the conversation health score.
 *
 * The score combines context utilization, turn count, and growth rate.
 * A conversation can be Critical from context alone (>= DEGRADING_CEIL, 90%) or from
 * a combination of moderate context + high turn count (the "attention
 * valley" effect from context rot research).
 */
export function computeHealthScore(input: HealthInput): HealthScore {
    const { contextPct, turnCount, growthRate } = input;

    // Rule 1: Very high context is always Critical, regardless of turn count.
    if (contextPct >= DEGRADING_CEIL) {
        return {
            level: 'critical',
            label: 'Critical',
            coaching: 'Context nearly full. Start a new chat, or use Claude Projects for ongoing work.',
            contextPct,
        };
    }

    // Rule 2: High context + many turns = Critical.
    // The "attention valley": past TURN_DEGRADING_CEIL turns with >= HEALTHY_CEIL (70%) context,
    // Claude's attention to mid-conversation details degrades measurably.
    if (contextPct >= HEALTHY_CEIL && turnCount > TURN_DEGRADING_CEIL) {
        return {
            level: 'critical',
            label: 'Critical',
            coaching: `${turnCount} turns deep. Claude has likely lost detail from early messages.`,
            contextPct,
        };
    }

    // Rule 3: Moderate context + moderate turns = Degrading.
    if (contextPct >= HEALTHY_CEIL && turnCount > TURN_HEALTHY_CEIL) {
        return {
            level: 'degrading',
            label: 'Degrading',
            coaching: 'Earlier details may be fading. Consider starting fresh soon.',
            contextPct,
        };
    }

    // Rule 4: Fast growth rate with meaningful context = Degrading.
    // Even at low turn counts, a conversation filling at >8%/turn will hit
    // Critical within a few more messages.
    if (growthRate !== null && growthRate > FAST_GROWTH_PCT && contextPct > 30) {
        const remaining = Math.max(0, Math.round((100 - contextPct) / growthRate));
        return {
            level: 'degrading',
            label: 'Degrading',
            coaching: `Filling fast. ~${remaining} message${remaining === 1 ? '' : 's'} until context limit.`,
            contextPct,
        };
    }

    // Rule 5: High turn count alone (even with low context) = mild Degrading.
    // Very long conversations develop attention drift regardless of context %.
    if (turnCount > TURN_CRITICAL_CEIL) {
        return {
            level: 'degrading',
            label: 'Degrading',
            coaching: 'Long conversation. Starting fresh often gives sharper responses.',
            contextPct,
        };
    }

    // Default: Healthy.
    return {
        level: 'healthy',
        label: 'Healthy',
        coaching: contextPct > 30
            ? `${contextPct.toFixed(0)}% context used. Plenty of room.`
            : 'Conversation is fresh and responsive.',
        contextPct,
    };
}

/**
 * Compute average upward growth rate from a context history array.
 * Returns null if there are fewer than 2 data points or no upward movement.
 * Same logic as context-intelligence.ts but extracted here for reuse.
 */
export function computeGrowthRate(contextHistory: number[]): number | null {
    if (contextHistory.length < 2) return null;
    let totalGrowth = 0;
    let growthCount = 0;
    for (let i = 1; i < contextHistory.length; i++) {
        const delta = contextHistory[i] - contextHistory[i - 1];
        if (delta > 0) {
            totalGrowth += delta;
            growthCount++;
        }
    }
    if (growthCount === 0) return null;
    return totalGrowth / growthCount;
}
