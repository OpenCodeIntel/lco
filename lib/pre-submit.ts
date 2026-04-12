// lib/pre-submit.ts
// Pre-Submit Agent: predicts the session cost of a draft message before sending.
// No DOM refs, no chrome APIs, no side effects. Pure functions only.
//
// ── Role in the multi-agent architecture ──────────────────────────────────────
//
// Each lib/ module is an agent with a single responsibility and a clean interface.
// The content script (claude-ai.content.ts) is the orchestrator that wires agents.
//
// | Agent              | Module                  | Input               | Output              |
// |--------------------|-------------------------|---------------------|---------------------|
// | Intelligence Agent | context-intelligence.ts | ConversationState   | ContextSignal[]     |
// | Prompt Agent       | prompt-analysis.ts      | PromptChars + model | ContextSignal[]     |
// | Delta Coach        | delta-coaching.ts       | DeltaCoachInput     | ContextSignal[]     |
// | **Pre-Submit**     | **pre-submit.ts**       | **PreSubmitInput**  | **PreSubmitEstimate** |
// | Health Agent       | health-score.ts         | contextPct, etc.    | HealthScore         |
// | Pricing Agent      | pricing.ts              | model, tokens       | cost (USD)          |
// | Memory Agent       | conversation-store.ts   | conversationId      | ConversationRecord  |
// | Token Economics    | token-economics.ts      | UsageDelta[]        | medians per model   |
//
// ── Agent contract ───────────────────────────────────────────────────────────
//
// Input:  PreSubmitInput (draft char count, model, token economics, session %)
// Output: PreSubmitEstimate (tokens, session %, model comparisons, warning)
//         or null when draft is below minimum threshold
//
// The session % prediction uses medianPctPerInputToken from the Token Economics
// agent. This metric is derived from real usage data: for each historical turn,
// deltaUtilization / inputTokens gives the session % consumed per input token.
// Because deltaUtilization captures the full round-trip cost (input + response +
// overhead), this implicitly accounts for typical response sizes without guessing
// an output multiplier.
//
// ── Data flow ────────────────────────────────────────────────────────────────
//
// Two paths deliver draft data to this agent:
//
// 1. Type-time: content script observes compose box via MutationObserver,
//    reads textContent on input events (debounced 500ms), passes char count.
//
// 2. Pre-send fallback: inject.ts reads the request body at fetch time
//    (already captured as promptText), posts DRAFT_ESTIMATE bridge message.
//    This fires even if the compose box observer failed to attach.
//
// In both cases, the content script calls computePreSubmitEstimate() with
// data already available in its scope (cachedPctPerInputToken, lastKnownUtilization).
// ─────────────────────────────────────────────────────────────────────────────

import { classifyModelTier } from './prompt-analysis';

// ── Types ────────────────────────────────────────────────────────────────────

/** Input to the Pre-Submit Agent. All data is passed in by the orchestrator. */
export interface PreSubmitInput {
    /** Character count of the compose box text. */
    draftCharCount: number;
    /** Current model (from convState or last known). */
    model: string;
    /** Median session % per input token, keyed by model. Null if not yet loaded. */
    pctPerInputToken: Record<string, number> | null;
    /** Current 5-hour session utilization (0-100), from Anthropic's usage endpoint. */
    currentSessionPct: number;
}

/** One row in the model comparison table. */
export interface ModelComparison {
    /** Full model name (e.g. "claude-opus-4-6"). */
    model: string;
    /** Human-readable label (e.g. "Opus"). */
    label: string;
    /** Estimated session % this draft would cost on this model. */
    estimatedPct: number;
}

/** Output of the Pre-Submit Agent. */
export interface PreSubmitEstimate {
    /** Approximate input token count (chars / 4). */
    estimatedTokens: number;
    /** Estimated session % this draft will cost. Null when token economics missing. */
    estimatedSessionPct: number | null;
    /** currentSessionPct + estimatedSessionPct. Null if either is null. */
    projectedTotalPct: number | null;
    /** Populated only when estimatedSessionPct > MODEL_COMPARE_THRESHOLD_PCT. Sorted ascending by cost. */
    modelComparisons: ModelComparison[];
    /** Warning message when projectedTotalPct >= WARNING_ZONE_PCT. */
    warning: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum draft length (chars) before showing an estimate. Below this, the
 * compose box likely contains a partial word or accidental keystroke.
 */
export const MIN_DRAFT_CHARS = 20;

/**
 * Show model comparison when estimated session cost exceeds this threshold.
 * Below 5%, the cost is low enough that model switching is not actionable.
 */
export const MODEL_COMPARE_THRESHOLD_PCT = 5;

/**
 * Warning zone: projected total session usage after this message.
 * At 90%+, the user should know they are about to hit the session limit.
 */
export const WARNING_ZONE_PCT = 90;

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Predict the session cost of a draft message.
 *
 * Returns null when the draft is below MIN_DRAFT_CHARS. When token economics
 * data is missing for the current model, returns an estimate with token count
 * but null session % (honest: we show what we know, omit what we don't).
 *
 * @param input - PreSubmitInput assembled by the content script orchestrator.
 * @returns PreSubmitEstimate or null if draft is too short.
 */
export function computePreSubmitEstimate(input: PreSubmitInput): PreSubmitEstimate | null {
    const { draftCharCount, model, pctPerInputToken, currentSessionPct } = input;

    if (draftCharCount < MIN_DRAFT_CHARS) return null;

    const estimatedTokens = Math.round(draftCharCount / 4);

    // Session % prediction: use real historical data, not a guessed multiplier.
    // medianPctPerInputToken is derived from actual delta records and implicitly
    // accounts for the typical response size.
    let estimatedSessionPct: number | null = null;
    if (pctPerInputToken !== null) {
        const rate = pctPerInputToken[model];
        if (rate !== undefined && rate > 0) {
            estimatedSessionPct = estimatedTokens * rate;
        }
    }

    const projectedTotalPct = estimatedSessionPct !== null
        ? currentSessionPct + estimatedSessionPct
        : null;

    // Model comparison: only when the cost is high enough to make switching worthwhile.
    const modelComparisons: ModelComparison[] = [];
    if (estimatedSessionPct !== null && estimatedSessionPct > MODEL_COMPARE_THRESHOLD_PCT && pctPerInputToken !== null) {
        for (const [m, rate] of Object.entries(pctPerInputToken)) {
            if (rate <= 0) continue;
            const tier = classifyModelTier(m);
            if (!tier) continue;
            modelComparisons.push({
                model: m,
                label: tier.label,
                estimatedPct: estimatedTokens * rate,
            });
        }
        modelComparisons.sort((a, b) => a.estimatedPct - b.estimatedPct);
    }

    // Warning when sending this message would push into the critical zone.
    let warning: string | null = null;
    if (projectedTotalPct !== null && projectedTotalPct >= WARNING_ZONE_PCT) {
        warning = `Sending this will push your session to ~${Math.round(projectedTotalPct)}%. Consider starting fresh or switching models.`;
    }

    return {
        estimatedTokens,
        estimatedSessionPct,
        projectedTotalPct,
        modelComparisons,
        warning,
    };
}
