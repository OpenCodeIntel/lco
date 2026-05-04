// lib/health-score.ts
//
// Pure function: conversation metadata -> human-readable health assessment.
// No DOM refs, no chrome APIs, no side effects.
//
// The health score replaces raw "73% ctx" with a three-state indicator
// (Healthy / Degrading / Critical) and a one-line coaching message that
// tells the user exactly what is happening and what to do about it.
//
// ── How the score is computed (READ THIS BEFORE EDITING) ────────────────
//
// A fresh-session guard runs first, then two independent classifiers run
// in sequence and the more severe wins:
//
//   0. FRESH-SESSION GUARD. Any conversation with turnCount at or below
//      FRESH_SESSION_TURN_CEIL AND contextPct strictly below
//      FRESH_SESSION_CONTEXT_CEIL is Healthy unconditionally. This blocks
//      stale state (growthRate from a prior conversation, leaked
//      isDetailHeavy, future projection wrappers) from escalating a
//      session that has no real history yet. The contract is "fresh =
//      Healthy", measured against truth (real turn count, real context
//      fill), not against derived signals. Wrappers like
//      escalateForProjection still run on the returned HealthScore and
//      can escalate it later if a real draft is active.
//
//   1. PRIMARY (per-model utilization). The conversation's context % is
//      compared to model-specific warn / critical thresholds from
//      context-rot-thresholds.ts. This is the load-bearing signal.
//      Anthropic's published MRCR scores ground the thresholds where they
//      exist; otherwise we use Saar coaching defaults documented in
//      docs/context-rot-thresholds-spec.md.
//
//   2. SECONDARY (turn count and growth rate). A long conversation with
//      few tokens, or a fast-filling short conversation, deserves
//      coaching even before the per-model threshold trips. These are
//      weaker signals so they cannot escalate above the primary level
//      they would otherwise produce, except for one explicit boost:
//      already-degrading + very-long-convo escalates to critical because
//      the attention valley research suggests retrieval is falling apart
//      regardless of model class.
//
// Detail-heavy adjustment: when the user's last prompt demanded precision
// (code blocks, precision keywords), the per-model warn / crit thresholds
// shift earlier. The shift is applied once, in the threshold lookup, so
// every rule below sees the adjusted numbers without special-casing.
//
// Coaching copy comes from context-rot-thresholds.ts when the primary
// classifier fires (model-aware, evidence-grounded). When a secondary
// rule fires alone, we use generic copy that names the model but does
// not invent threshold-specific claims. This keeps copy honest: we never
// quote an MRCR figure on a turn-count-driven warning.
// ─────────────────────────────────────────────────────────────────────────

import {
    ABSOLUTE_CRITICAL_FLOOR,
    LOW_CONTEXT_REASSURANCE_CEIL,
    getEffectiveThresholds,
    getRotCoaching,
    getRotProfile,
    getRotZone,
} from './context-rot-thresholds';

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

/**
 * Absolute floor: any conversation at or above this context % is critical
 * regardless of model. Re-exported from context-rot-thresholds.ts so the
 * legacy "DEGRADING_CEIL = 90" assertions in audit tests keep working
 * without binding the test file to the new agent path.
 */
export const DEGRADING_CEIL = ABSOLUTE_CRITICAL_FLOOR;

/**
 * Legacy default warn threshold. Pre-GET-28, this was the single
 * model-agnostic warn ceiling. Now superseded by per-model thresholds in
 * context-rot-thresholds.ts. Kept exported for tests and call sites that
 * still reference it as a sentinel value, NOT used by computeHealthScore.
 */
export const HEALTHY_CEIL = 70;

// Turn count thresholds. Long conversations develop attention drift even
// when context is low, per the U-shaped attention curve from the Chroma
// 2025 context-rot research.
export const TURN_HEALTHY_CEIL = 10;
export const TURN_DEGRADING_CEIL = 20;
export const TURN_CRITICAL_CEIL = 30;

/**
 * Growth rate threshold (% per turn). A conversation filling at this rate
 * or faster is on track to hit the per-model warn threshold within a
 * handful of messages. Triggers a forward-looking warning before the
 * primary classifier would fire.
 */
export const FAST_GROWTH_PCT = 8;

/**
 * How far below the per-model warn threshold the turn-aware degrading
 * rule (Rule 6) starts firing. With warn = 60 (Sonnet 4.6) and offset =
 * 10, a 12-turn conversation at 50%+ context is degrading even though
 * it has not yet crossed the per-model warn. Rationale: the attention
 * valley research shows fidelity erodes as turns accumulate, and the
 * 10-point band gives the indicator room to coach the user before the
 * primary classifier trips.
 */
export const TURN_AWARE_WARN_OFFSET = 10;

/**
 * Fresh-session guard ceilings. A conversation at or below this turn
 * count AND strictly below this context % is Healthy regardless of any
 * derived signal (growthRate, isDetailHeavy, future projection wrappers).
 *
 * Rationale: the U-shaped attention research that drives every other rule
 * here requires meaningful turn count and meaningful context fill to make
 * a confident prediction. At zero or near-zero of both, every secondary
 * signal is noise. We refuse to coach on noise. The ceilings come from
 * GET-36 acceptance criteria: turnCount <= 2 AND contextPct < 30.
 *
 * The contextPct ceiling is exclusive on purpose. Any conversation that
 * has reached 30% of the model's window has enough context fill that the
 * per-model warn / critical thresholds (which start at 50% on the most
 * conservative profile) deserve their full classifier pass. The turnCount
 * ceiling is inclusive: a turn-2 reply on a brand-new chat is still
 * indistinguishable from a turn-1 or turn-0 state for our purposes.
 */
export const FRESH_SESSION_TURN_CEIL = 2;
export const FRESH_SESSION_CONTEXT_CEIL = 30;

// ── Score computation ─────────────────────────────────────────────────────────

export interface HealthInput {
    /** Current context utilization, 0 to 100, as a % of the model's window. */
    contextPct: number;
    /** Number of user-assistant turn pairs so far. */
    turnCount: number;
    /** Average upward growth per turn (% per turn), or null if insufficient data. */
    growthRate: number | null;
    /**
     * Model name as reported by the SSE message_start event (e.g.
     * 'claude-sonnet-4-6-20250514'). Used to look up per-model warn /
     * critical thresholds and to name the model in coaching copy. Pass
     * an empty string for unknown models; the agent will fall back to
     * a conservative 200k / 50% / 75% profile.
     */
    model: string;
    /**
     * True when the most recent prompt demanded precise / exhaustive
     * recall (code blocks or precision keywords). Computed by
     * lib/prompt-analysis.ts isDetailHeavy(). Shifts the per-model warn
     * and critical thresholds earlier by DETAIL_HEAVY_ADJUSTMENT.
     */
    isDetailHeavy: boolean;
}

/**
 * Compute the conversation health score.
 *
 * Returns the worst (most severe) of the primary per-model classifier
 * and the secondary turn / growth heuristics. Coaching copy is sourced
 * from the rule that won, so a turn-count-driven warning does not pretend
 * to quote MRCR data it never used.
 */
export function computeHealthScore(input: HealthInput): HealthScore {
    const { contextPct, turnCount, growthRate, model, isDetailHeavy } = input;

    // Rule 0 (fresh-session guard): a session with too few turns AND too
    // little context fill cannot be in any rot zone we can confidently
    // claim. Return Healthy before the secondary signals (growthRate,
    // turn-count rules) get a chance to fire on noise. The model-aware
    // coaching string still names the model so the copy stays consistent
    // with what the user sees once the conversation matures.
    if (turnCount <= FRESH_SESSION_TURN_CEIL && contextPct < FRESH_SESSION_CONTEXT_CEIL) {
        return {
            level: 'healthy',
            label: 'Healthy',
            coaching: getRotCoaching(model, contextPct, isDetailHeavy),
            contextPct,
        };
    }

    const profile = getRotProfile(model);
    const thresholds = getEffectiveThresholds(model, isDetailHeavy);
    const zone = getRotZone(model, contextPct, isDetailHeavy);

    // Rule 1 (primary): in-rot zone is always critical. This includes the
    // absolute 90% floor since getRotZone honors it. Coaching is the
    // model-aware in-rot message: cites the model, mentions compaction
    // for 1M models, points 200k models at Projects + new chat.
    if (zone === 'in-rot') {
        return {
            level: 'critical',
            label: 'Critical',
            coaching: getRotCoaching(model, contextPct, isDetailHeavy),
            contextPct,
        };
    }

    // Rule 2 (secondary boost): if we are already in the approaching zone
    // AND the conversation is past TURN_DEGRADING_CEIL turns, we promote
    // to critical. Rationale: the per-model warn threshold is the point
    // where retrieval starts dropping; combined with a deep conversation,
    // the user is statistically losing fidelity from earlier turns even
    // if the percentage alone would not yet trip critical.
    if (zone === 'approaching' && turnCount > TURN_DEGRADING_CEIL) {
        return {
            level: 'critical',
            label: 'Critical',
            coaching: `${turnCount} turns deep on ${profile.label}. Earlier details are likely missing from recall. Start a new chat.`,
            contextPct,
        };
    }

    // Rule 3 (primary): approaching zone without the turn boost is
    // degrading. Use the per-model coaching string, which decides whether
    // to cite MRCR, mention compaction, or push toward Projects.
    if (zone === 'approaching') {
        return {
            level: 'degrading',
            label: 'Degrading',
            coaching: getRotCoaching(model, contextPct, isDetailHeavy),
            contextPct,
        };
    }

    // ── At this point the primary classifier says "healthy". Secondary
    // signals can downgrade to "degrading" but never to "critical" on
    // their own; the primary classifier is the only path to red. ──

    // Rule 4 (secondary): fast growth at meaningful context is degrading.
    // We only fire above LOW_CONTEXT_REASSURANCE_CEIL because tiny chats
    // can show large per-turn growth as a percentage with no real risk.
    // The remaining-messages estimate uses the post-detail-heavy warn
    // threshold so it answers "messages until we hit the warning", not
    // "messages until we exhaust the entire window".
    if (growthRate !== null && growthRate > FAST_GROWTH_PCT && contextPct > LOW_CONTEXT_REASSURANCE_CEIL) {
        const headroom = Math.max(0, thresholds.warnAtPct - contextPct);
        // Floor the displayed count at 1: a "0 messages" warning is silly
        // when the rule has already decided we should warn. Rounding can
        // produce 0 when headroom < growthRate / 2 (e.g. headroom=2pp,
        // growthRate=9pp/turn -> 0.22 -> 0). Show "1 message" instead.
        const rawRemaining = Math.round(headroom / growthRate);
        const remaining = Math.max(1, rawRemaining);
        const target = remaining === 1 ? 'message' : 'messages';
        return {
            level: 'degrading',
            label: 'Degrading',
            coaching: `Filling fast on ${profile.label}. About ${remaining} ${target} until the rot zone.`,
            contextPct,
        };
    }

    // Rule 5 (secondary): very long conversations develop attention drift
    // even at low utilization. The turn ceiling is generic; no model
    // claim attached.
    if (turnCount > TURN_CRITICAL_CEIL) {
        return {
            level: 'degrading',
            label: 'Degrading',
            coaching: 'Long conversation. Starting fresh often gives sharper responses.',
            contextPct,
        };
    }

    // Rule 6 (degrading boost from turns at high-but-healthy context):
    // when context is moderate AND we are past TURN_HEALTHY_CEIL, the
    // attention valley starts kicking in even before the per-model warn.
    // Threshold: anything within TURN_AWARE_WARN_OFFSET points of warn
    // (so a Sonnet 4.5 user at 45% with 12 turns trips this; an Opus
    // 4.7 user at 45% with 12 turns does not, because warn = 65). This
    // preserves the legacy "70% + 11 turns = degrading" coverage without
    // locking it to 70.
    const turnAwareWarnFloor = thresholds.warnAtPct - TURN_AWARE_WARN_OFFSET;
    if (contextPct >= turnAwareWarnFloor && turnCount > TURN_HEALTHY_CEIL && contextPct > LOW_CONTEXT_REASSURANCE_CEIL) {
        return {
            level: 'degrading',
            label: 'Degrading',
            coaching: `${turnCount} turns into ${profile.label}. Earlier details may be fading; consider starting fresh soon.`,
            contextPct,
        };
    }

    // Default: healthy. Use the per-model coaching for both the very-low
    // case (returns "fresh and responsive") and the moderate case
    // (returns "X% of {label}'s {window} window used. Plenty of room.").
    return {
        level: 'healthy',
        label: 'Healthy',
        coaching: getRotCoaching(model, contextPct, isDetailHeavy),
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
