// lib/context-rot-thresholds.ts
//
// Per-model context rot agent. Single source of truth for:
//   1. The context window size that defines 100% utilization
//   2. The "warn" threshold where Saar starts coaching the user toward fresh
//   3. The "critical" threshold where retrieval is likely already unreliable
//   4. The "detail-heavy" adjustment when the user's prompt demands precision
//   5. The user-facing coaching copy, grounded in Anthropic-published facts
//      where they exist and clearly marked as Saar defaults where they don't
//
// No DOM refs, no chrome APIs, no side effects. Pure functions only.
//
// ── Why this file exists ──────────────────────────────────────────────────
//
// Anthropic publishes that "as token count grows, accuracy and recall
// degrade, a phenomenon known as context rot" (platform.claude.com docs,
// build-with-claude/context-windows). They publish two anchor data points:
//
//   - Opus 4.6 retrieves 76% on the 8-needle 1M variant of MRCR v2
//   - Sonnet 4.5 retrieves 18.5% on the same benchmark at the same length
//
// Source: https://www.anthropic.com/news/claude-opus-4-6
//
// Anthropic does NOT publish a rot CURVE. They give endpoints, not a graph.
// So picking "the threshold at which a user should be warned" is Saar's
// coaching judgment, derived from those endpoints. This file is that
// judgment, encoded once, with provenance.
//
// Why hard-code rather than infer:
//   - We refuse to invent Anthropic claims. If Anthropic says nothing about
//     Opus 4.7, we use Opus 4.6's pattern as a sibling and document why.
//   - The spec doc (docs/context-rot-thresholds-spec.md) is the human-readable
//     companion that explains every choice. If Anthropic publishes new MRCR
//     numbers, update both this file and the spec, nowhere else.
//
// ── Detail-heavy adjustment ──────────────────────────────────────────────
//
// Retrieval failure cost rises sharply when the user's prompt demands
// precision. A casual "summarize this thread" can tolerate fuzzy recall;
// "list every parameter we discussed for the auth refactor" cannot. When
// the prompt signals high precision (code blocks, or precision keywords),
// we subtract DETAIL_HEAVY_ADJUSTMENT from both the warn and critical
// thresholds. This shifts the warning earlier, where it matters most.
//
// We floor the adjusted threshold at MIN_THRESHOLD_FLOOR so a stack of
// adjustments cannot push the warning to absurdly low context.
// ─────────────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────────

export type RotZone = 'healthy' | 'approaching' | 'in-rot';

/**
 * One row in the threshold table. Matched by longest model-name prefix.
 * Anything in `mrcrAt1MPct` / `sourceUrl` / `sourceQuote` MUST come from a
 * verified Anthropic publication. Saar defaults are absent from those fields.
 */
export interface ContextRotProfile {
    /** Model-name prefix (longest match wins). */
    modelPrefix: string;
    /** Display label used in coaching copy. */
    label: string;
    /** Token capacity that defines 100% utilization. Mirrors pricing.json. */
    contextWindow: number;
    /** % of window at which Saar starts the "approaching rot" warning. */
    warnAtPct: number;
    /** % of window at which Saar declares "in rot zone". */
    criticalAtPct: number;
    /**
     * Anthropic-published 8-needle 1M MRCR v2 score for this model, if any.
     * Only set when we can quote the exact figure verbatim from an
     * Anthropic source. Used in coaching copy to show the user the
     * primary-source evidence behind the warning.
     */
    mrcrAt1MPct?: number;
    /** Anthropic primary-source URL for the MRCR figure. */
    sourceUrl?: string;
    /** Verbatim quote pinning the figure, for the spec drift test. */
    sourceQuote?: string;
    /**
     * Whether Anthropic offers server-side compaction for this model on its
     * platform. When true, the coaching copy softens, since Anthropic itself
     * handles long sessions. When false, the user must act (start fresh,
     * use Projects). Compaction beta as of 2026-04: Opus 4.7, Opus 4.6,
     * Sonnet 4.6.
     */
    hasServerSideCompaction: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Subtracted from both warnAtPct and criticalAtPct when the latest prompt
 * is detail-heavy. 15 percentage points is the value documented in the
 * GET-28 issue spec: enough to noticeably shift the warning earlier, not
 * so much it floods the user on a normal Q&A.
 */
export const DETAIL_HEAVY_ADJUSTMENT = 15;

/**
 * Floor applied after the detail-heavy adjustment. Prevents the threshold
 * from sliding below a sensible minimum if future tuning combines multiple
 * downward adjustments. 30% is far enough below any current model's warn
 * threshold that the floor only fires in adjustment edge cases.
 */
export const MIN_THRESHOLD_FLOOR = 30;

/**
 * Absolute hard cap, model-agnostic. No model is reliable above this
 * utilization, regardless of its published MRCR score. Acts as a safety
 * net so the critical signal always fires near the window limit even if
 * the model lookup falls through. This mirrors the legacy DEGRADING_CEIL
 * behavior so existing audit assertions about "context >= 90 = critical"
 * still hold.
 */
export const ABSOLUTE_CRITICAL_FLOOR = 90;

/**
 * Below this context % the coaching layer keeps the message minimal
 * ("fresh and responsive") instead of spelling out the percentage. The
 * Health Agent uses the same constant to gate its "fast growth" warning,
 * since tiny chats can show large per-turn growth as a percentage with
 * no real risk. Lives here so both the threshold agent's coaching copy
 * and the health-score rule see the same value without a circular import.
 */
export const LOW_CONTEXT_REASSURANCE_CEIL = 30;

// Source URLs pinned once. If they 404 in the spec drift test, we know.
const URL_OPUS_4_6_ANNOUNCEMENT = 'https://www.anthropic.com/news/claude-opus-4-6';
const URL_CONTEXT_WINDOWS_DOCS = 'https://platform.claude.com/docs/en/build-with-claude/context-windows';

// Verbatim quote from the Opus 4.6 announcement, pinned for the drift test.
// Both Opus 4.6 and Sonnet 4.5 share this quote since it names both scores.
const QUOTE_MRCR_OPUS_4_6_AND_SONNET_4_5 =
    'on the 8-needle 1M variant of MRCR v2, a needle-in-a-haystack benchmark that tests a model\'s ability to retrieve information "hidden" in vast amounts of text, Opus 4.6 scores 76%, whereas Sonnet 4.5 scores just 18.5%.';

// ── Threshold table ──────────────────────────────────────────────────────
//
// Order matters: longest-prefix-first scan, so we list the most specific
// entries (e.g. claude-sonnet-4-6) before the generic ones. Each row
// carries enough context (label + window + provenance) that the coaching
// string can be assembled without lookups elsewhere.
//
// Threshold derivation (see docs/context-rot-thresholds-spec.md for full
// rationale):
//   - 1M-window models with strong long-context performance (Opus 4.6 at
//     76% MRCR) hold accuracy further into the window. Warn at 65, crit
//     at 85. Opus 4.7 inherits this until Anthropic publishes a number.
//   - 1M-window Sonnet 4.6 has no published MRCR. Anthropic markets it as
//     a long-context improvement over Sonnet 4.5. We warn at 60 (more
//     conservative than Opus, less than 200k Sonnet) and crit at 80.
//   - 200k-window models with weak long-context (Sonnet 4.5 at 18.5%
//     MRCR) lose accuracy fast as % climbs. Warn at 50, crit at 75.
//   - Haiku 4.5 has no published MRCR but a smaller window. Use the
//     conservative 200k profile.
//   - Older 200k-window Opus models (4.5, 4.1) inherit the 200k profile.
//
// Saar defaults (warn/crit) are NOT Anthropic-published thresholds. The
// spec doc says so explicitly. Only the mrcrAt1MPct field is sourced.

export const ROT_PROFILES: ContextRotProfile[] = [
    // 1M-window flagships, compaction-aware. Opus 4.6 has a verified MRCR.
    {
        modelPrefix: 'claude-opus-4-7',
        label: 'Opus 4.7',
        contextWindow: 1_000_000,
        warnAtPct: 65,
        criticalAtPct: 85,
        hasServerSideCompaction: true,
    },
    {
        modelPrefix: 'claude-opus-4-6',
        label: 'Opus 4.6',
        contextWindow: 1_000_000,
        warnAtPct: 65,
        criticalAtPct: 85,
        mrcrAt1MPct: 76,
        sourceUrl: URL_OPUS_4_6_ANNOUNCEMENT,
        sourceQuote: QUOTE_MRCR_OPUS_4_6_AND_SONNET_4_5,
        hasServerSideCompaction: true,
    },
    {
        modelPrefix: 'claude-sonnet-4-6',
        label: 'Sonnet 4.6',
        contextWindow: 1_000_000,
        warnAtPct: 60,
        criticalAtPct: 80,
        hasServerSideCompaction: true,
    },

    // 200k-window models, no server-side compaction available. Sonnet 4.5
    // is the rot exemplar: 18.5% MRCR at full window means accuracy is
    // measurably degraded well before the user hits the limit.
    {
        modelPrefix: 'claude-sonnet-4-5',
        label: 'Sonnet 4.5',
        contextWindow: 200_000,
        warnAtPct: 50,
        criticalAtPct: 75,
        mrcrAt1MPct: 18.5,
        sourceUrl: URL_OPUS_4_6_ANNOUNCEMENT,
        sourceQuote: QUOTE_MRCR_OPUS_4_6_AND_SONNET_4_5,
        hasServerSideCompaction: false,
    },
    {
        modelPrefix: 'claude-haiku-4',
        label: 'Haiku 4.5',
        contextWindow: 200_000,
        warnAtPct: 50,
        criticalAtPct: 75,
        hasServerSideCompaction: false,
    },

    // Legacy Opus generations on the 200k window. Devanshu notes nobody
    // uses these on claude.ai today, but we keep them in the table so the
    // health indicator does not silently fall through to the unknown-model
    // fallback for anyone who still has them pinned.
    {
        modelPrefix: 'claude-opus-4-5',
        label: 'Opus 4.5',
        contextWindow: 200_000,
        warnAtPct: 50,
        criticalAtPct: 75,
        hasServerSideCompaction: false,
    },
    {
        modelPrefix: 'claude-opus-4-1',
        label: 'Opus 4.1',
        contextWindow: 200_000,
        warnAtPct: 50,
        criticalAtPct: 75,
        hasServerSideCompaction: false,
    },
];

/**
 * Fallback profile for unknown / unrecognized model strings. Intentionally
 * conservative: a 200k window with the same warn/crit defaults as Sonnet
 * 4.5. Better to over-warn an unknown model than to leave the user
 * unprotected on a model we have not characterized.
 */
export const FALLBACK_PROFILE: ContextRotProfile = {
    modelPrefix: '',
    label: 'this model',
    contextWindow: 200_000,
    warnAtPct: 50,
    criticalAtPct: 75,
    hasServerSideCompaction: false,
};

// ── Lookup ──────────────────────────────────────────────────────────────

/**
 * Returns the rot profile for the given model name. Matches by longest
 * prefix so version suffixes (claude-sonnet-4-6-20250514) resolve to the
 * canonical entry (claude-sonnet-4-6). Falls back to FALLBACK_PROFILE for
 * unknown models.
 *
 * Lookup is case-insensitive on the input but the table is lowercase, so
 * we normalize the input before scanning.
 */
export function getRotProfile(model: string): ContextRotProfile {
    if (!model) return FALLBACK_PROFILE;
    const normalized = model.toLowerCase();

    // Longest-prefix scan with a digit-boundary check. Without the boundary
    // a hypothetical future model name like "claude-sonnet-4-50" would
    // falsely match the "claude-sonnet-4-5" entry, classifying it as the
    // 200k profile. Only accept the prefix when the model name ends there
    // OR the next character is a non-digit (typically '-' before a date
    // suffix like "-20250514"). This way "claude-sonnet-4-5" and
    // "claude-sonnet-4-5-20250929" both match the 4-5 row, but a future
    // "claude-sonnet-4-50" falls through to the FALLBACK_PROFILE.
    let best: ContextRotProfile | null = null;
    for (const profile of ROT_PROFILES) {
        if (!normalized.startsWith(profile.modelPrefix)) continue;
        const nextChar = normalized.charAt(profile.modelPrefix.length);
        const boundaryOk = nextChar === '' || nextChar < '0' || nextChar > '9';
        if (!boundaryOk) continue;
        if (best === null || profile.modelPrefix.length > best.modelPrefix.length) {
            best = profile;
        }
    }
    return best ?? FALLBACK_PROFILE;
}

/**
 * Effective thresholds after applying the detail-heavy adjustment.
 * Both warn and crit shift down by DETAIL_HEAVY_ADJUSTMENT, floored at
 * MIN_THRESHOLD_FLOOR.
 */
export interface EffectiveThresholds {
    warnAtPct: number;
    criticalAtPct: number;
}

export function getEffectiveThresholds(
    model: string,
    isDetailHeavy: boolean,
): EffectiveThresholds {
    const profile = getRotProfile(model);
    return {
        warnAtPct: applyDetailHeavyAdjustment(profile.warnAtPct, isDetailHeavy),
        criticalAtPct: applyDetailHeavyAdjustment(profile.criticalAtPct, isDetailHeavy),
    };
}

/**
 * Apply the detail-heavy adjustment to a single threshold value, with the
 * MIN_THRESHOLD_FLOOR guard. Exported so tests can exercise the floor
 * branch independently of the threshold table (no real profile in the
 * table is low enough to trip the floor today; the floor is here as a
 * guard for future tuning that combines downward adjustments).
 */
export function applyDetailHeavyAdjustment(threshold: number, isDetailHeavy: boolean): number {
    if (!isDetailHeavy) return threshold;
    return Math.max(MIN_THRESHOLD_FLOOR, threshold - DETAIL_HEAVY_ADJUSTMENT);
}

/**
 * Three-way zone classification given the user's current context %, the
 * model, and whether their last prompt was detail-heavy.
 *
 * The zones map to the existing health levels in `lib/health-score.ts`:
 *   healthy    -> Healthy
 *   approaching -> Degrading
 *   in-rot     -> Critical
 *
 * Plus, an absolute floor: anything at ABSOLUTE_CRITICAL_FLOOR (90%) or
 * above is "in-rot" regardless of model. This guarantees the health
 * indicator goes red before the user actually hits the wall.
 */
export function getRotZone(
    model: string,
    contextPct: number,
    isDetailHeavy: boolean,
): RotZone {
    if (contextPct >= ABSOLUTE_CRITICAL_FLOOR) return 'in-rot';
    const { warnAtPct, criticalAtPct } = getEffectiveThresholds(model, isDetailHeavy);
    if (contextPct >= criticalAtPct) return 'in-rot';
    if (contextPct >= warnAtPct) return 'approaching';
    return 'healthy';
}

// ── Coaching copy ────────────────────────────────────────────────────────
//
// Three zones, two model classes (with-compaction / without-compaction),
// optional MRCR citation when we have one. Copy is claude.ai-specific:
// never references `/compact` (Claude Code feature, not on the web), uses
// "start a new chat" and "use Projects" as the primary actions.

/**
 * Returns the user-facing coaching message for the given model and state.
 *
 * Healthy zone: low-friction reassurance, names the model and its window.
 * Approaching: educational, explains why, cites MRCR when we have it,
 *              gives a claude.ai-appropriate next step.
 * In-rot:      direct, action-first.
 *
 * The detail-heavy flag does not change the copy itself, only the
 * threshold at which the zone trips. This is intentional: the user
 * already feels the precision pressure, the warning just arrives sooner.
 */
export function getRotCoaching(
    model: string,
    contextPct: number,
    isDetailHeavy: boolean,
): string {
    const profile = getRotProfile(model);
    const zone = getRotZone(model, contextPct, isDetailHeavy);
    const windowLabel = formatWindowLabel(profile.contextWindow);
    const pctRounded = Math.round(contextPct);

    if (zone === 'healthy') {
        // Low context: low friction. Mention the model only when there is
        // anything to say beyond "fresh".
        if (contextPct < LOW_CONTEXT_REASSURANCE_CEIL) {
            return 'Conversation is fresh and responsive.';
        }
        return `${pctRounded}% of ${profile.label}'s ${windowLabel} window used. Plenty of room.`;
    }

    if (zone === 'approaching') {
        // Educational moment. Cite MRCR when available, soften when
        // compaction is present, harden when it is not.
        const mrcrClause = profile.mrcrAt1MPct !== undefined
            ? ` On Anthropic's 8-needle 1M MRCR benchmark, ${profile.label} retrieves ${profile.mrcrAt1MPct}% at full window.`
            : '';
        const action = profile.hasServerSideCompaction
            ? "Anthropic's server-side compaction handles long sessions, but for accuracy-critical work consider starting a new chat."
            : 'For accuracy-critical work, start a new chat now.';
        return `Approaching the zone where retrieval declines.${mrcrClause} ${action}`;
    }

    // in-rot zone
    if (profile.hasServerSideCompaction) {
        return `${pctRounded}% used. Even with compaction, fine details from earlier may be missed. Start a new chat for new threads of work.`;
    }
    return `${pctRounded}% used. Retrieval is unreliable here. Start a new chat. Use Projects to keep ongoing work organized.`;
}

/**
 * Formats a context window size for display. 1_000_000 -> "1M",
 * 200_000 -> "200k". Keeps the coaching copy short and scannable.
 */
function formatWindowLabel(contextWindow: number): string {
    if (contextWindow >= 1_000_000) {
        const millions = contextWindow / 1_000_000;
        return millions === Math.floor(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
    }
    const thousands = Math.round(contextWindow / 1_000);
    return `${thousands}k`;
}
