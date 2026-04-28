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
import { getContextWindowSize } from './pricing';
import type { AttachmentBreakdownItem } from './attachment-cost';

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
    /**
     * Lower-bound token contribution from attachments (image + PDF). Default 0.
     * Images contribute exact; PDFs contribute Anthropic's published low end.
     * Sourced from computeAttachmentCost in lib/attachment-cost.ts.
     */
    attachmentTokensLow?: number;
    /** Upper-bound token contribution. PDFs contribute the high end of the range. */
    attachmentTokensHigh?: number;
    /** Per-attachment rows for the overlay breakdown. Empty by default. */
    attachmentBreakdown?: readonly AttachmentBreakdownItem[];
    /** Hard warnings (e.g. PDF page caps exceeded). Empty by default. */
    attachmentWarnings?: readonly string[];
    /** True when at least one image is on a model with no published cost; UI shows "?". */
    hasUnknownImage?: boolean;
    /** True when at least one PDF is included; surfaces the per-page-image disclosure. */
    hasPdf?: boolean;
    /**
     * Current conversation context window utilization (0-100), as already
     * consumed by message history. The pre-submit estimate adds the projected
     * tokens for this turn on top to compute the projected context fill.
     * Default 0; the orchestrator passes state.contextPct.
     */
    currentContextPct?: number;
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
    /**
     * Lower-bound total input tokens for this draft (text + attachments).
     * Equals upper bound when no PDFs are present.
     */
    estimatedTokens: number;
    /** Upper-bound total. Differs from estimatedTokens only when a PDF is attached. */
    estimatedTokensHigh: number;
    /** Text-only token estimate (chars / 4). Useful for the breakdown line. */
    textTokens: number;
    /**
     * Estimated session % this draft will cost (low end). Null when token
     * economics missing. Computed from the LOW token total so the displayed
     * percentage is conservative; the high end is exposed separately.
     */
    estimatedSessionPct: number | null;
    /** Upper-bound session %. Equals estimatedSessionPct when no PDFs are present. */
    estimatedSessionPctHigh: number | null;
    /** currentSessionPct + estimatedSessionPct. Null if either is null. */
    projectedTotalPct: number | null;
    /** Populated only when estimatedSessionPct > MODEL_COMPARE_THRESHOLD_PCT. Sorted ascending by cost. */
    modelComparisons: ModelComparison[];
    /** Warning message when projectedTotalPct >= WARNING_ZONE_PCT. */
    warning: string | null;
    /** Per-attachment breakdown for the overlay (empty when no attachments). */
    attachmentBreakdown: readonly AttachmentBreakdownItem[];
    /** Hard warnings from the attachment agent (cap exceeded, etc.). */
    attachmentWarnings: readonly string[];
    /** Pass-through: image present on a model with no published cost. */
    hasUnknownImage: boolean;
    /** Pass-through: at least one PDF; UI shows "may cost more with charts" disclosure. */
    hasPdf: boolean;
    /**
     * Projected context-window utilization after sending this turn (low end).
     * currentContextPct + (estimatedTokens / contextWindowSize) * 100.
     * Null when the model has no known context window.
     */
    projectedContextPctLow: number | null;
    /** Projected context utilization at the upper bound (PDF range high end). */
    projectedContextPctHigh: number | null;
    /** Context window size in tokens for the model. */
    contextWindowSize: number;
    /**
     * Hard warning when the projection exceeds OVERRUN_ZONE_PCT of the context
     * window. Anthropic's own guidance: dense PDFs can fill the context window
     * before the page limit; this surfaces that risk before the user hits send.
     * Null when the projection is comfortable.
     */
    contextOverrunWarning: string | null;
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

/**
 * Context-window overrun threshold. Anthropic's PDF docs state: "Dense PDFs
 * can fill the context window before reaching the page limit." We warn when
 * the projected total context fill (history + this turn) exceeds 90 percent
 * so the user can split, downsample, or switch to a larger-context model
 * before the request gets truncated.
 */
export const CONTEXT_OVERRUN_ZONE_PCT = 90;

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Predict the session cost of a draft message.
 *
 * Returns null when the draft is below MIN_DRAFT_CHARS AND no attachments are
 * present. When token economics data is missing for the current model, returns
 * an estimate with token count but null session % (honest: we show what we
 * know, omit what we don't).
 *
 * Attachment tokens are summed into the estimate; the upper-bound fields
 * differ from the lower-bound only when a PDF is attached, since Anthropic
 * publishes PDF cost as a 1,500-3,000 per page range.
 *
 * @param input - PreSubmitInput assembled by the content script orchestrator.
 * @returns PreSubmitEstimate or null if draft has neither text nor attachments.
 */
export function computePreSubmitEstimate(input: PreSubmitInput): PreSubmitEstimate | null {
    const { draftCharCount, model, pctPerInputToken, currentSessionPct } = input;
    const attachmentTokensLow = input.attachmentTokensLow ?? 0;
    const attachmentTokensHigh = input.attachmentTokensHigh ?? 0;
    const attachmentBreakdown = input.attachmentBreakdown ?? [];
    const attachmentWarnings = input.attachmentWarnings ?? [];
    const hasUnknownImage = input.hasUnknownImage ?? false;
    const hasPdf = input.hasPdf ?? false;

    // Gate: either the text is long enough to estimate, or the user has
    // attached something we can describe. The DRAFT_ESTIMATE pre-send
    // fallback in inject.ts only sends draftCharCount, so the original gate
    // (text >= MIN_DRAFT_CHARS) is preserved when no attachments are passed.
    const hasAttachments = attachmentBreakdown.length > 0;
    if (draftCharCount < MIN_DRAFT_CHARS && !hasAttachments) return null;

    const textTokens = Math.round(draftCharCount / 4);
    const estimatedTokens = textTokens + attachmentTokensLow;
    const estimatedTokensHigh = textTokens + attachmentTokensHigh;

    // Session % prediction: use real historical data, not a guessed multiplier.
    // medianPctPerInputToken is derived from actual delta records and implicitly
    // accounts for the typical response size. Both bounds use the same rate;
    // they only differ in the token totals being multiplied.
    let estimatedSessionPct: number | null = null;
    let estimatedSessionPctHigh: number | null = null;
    if (pctPerInputToken !== null) {
        const rate = pctPerInputToken[model];
        if (rate !== undefined && rate > 0) {
            estimatedSessionPct = estimatedTokens * rate;
            estimatedSessionPctHigh = estimatedTokensHigh * rate;
        }
    }

    const projectedTotalPct = estimatedSessionPct !== null
        ? currentSessionPct + estimatedSessionPct
        : null;

    // Model comparison: only when the cost is high enough to make switching worthwhile.
    // Use the upper-bound token total for the comparison so a PDF-heavy draft
    // shows comparisons even if the low end falls under the threshold.
    const modelComparisons: ModelComparison[] = [];
    const compareTokens = Math.max(estimatedTokens, estimatedTokensHigh);
    if (estimatedSessionPctHigh !== null && estimatedSessionPctHigh > MODEL_COMPARE_THRESHOLD_PCT && pctPerInputToken !== null) {
        for (const [m, rate] of Object.entries(pctPerInputToken)) {
            if (rate <= 0) continue;
            const tier = classifyModelTier(m);
            if (!tier) continue;
            modelComparisons.push({
                model: m,
                label: tier.label,
                estimatedPct: compareTokens * rate,
            });
        }
        modelComparisons.sort((a, b) => a.estimatedPct - b.estimatedPct);
    }

    // Warning when sending this message would push into the critical zone.
    // Uses the LOW projection so the warning fires only when the floor of the
    // estimate already crosses 90 percent; otherwise the user gets a false
    // alarm whenever the high end of a PDF range happens to spike.
    let warning: string | null = null;
    if (projectedTotalPct !== null && projectedTotalPct >= WARNING_ZONE_PCT) {
        warning = `Sending this will push your session to ~${Math.round(projectedTotalPct)}%. Consider starting fresh or switching models.`;
    }

    // Context-window projection. The conversation history already consumes
    // currentContextPct of the model's context window; the new turn adds
    // textTokens + attachmentTokens on top. We expose both bounds so the UI
    // can show a range when a PDF is attached.
    const currentContextPct = input.currentContextPct ?? 0;
    const contextWindowSize = getContextWindowSize(model);
    let projectedContextPctLow: number | null = null;
    let projectedContextPctHigh: number | null = null;
    let contextOverrunWarning: string | null = null;
    if (contextWindowSize > 0) {
        projectedContextPctLow = currentContextPct + (estimatedTokens / contextWindowSize) * 100;
        projectedContextPctHigh = currentContextPct + (estimatedTokensHigh / contextWindowSize) * 100;

        // Use the HIGH projection so dense PDFs trigger the warning even when
        // the LOW range fits. This mirrors Anthropic's own caveat: "Dense PDFs
        // can fill the context window before reaching the page limit."
        if (projectedContextPctHigh >= CONTEXT_OVERRUN_ZONE_PCT) {
            const ctxK = Math.round(contextWindowSize / 1000);
            const pctRounded = Math.round(projectedContextPctHigh);
            contextOverrunWarning = projectedContextPctHigh >= 100
                ? `This turn likely exceeds the ${ctxK}k context window (~${pctRounded}%). Split the document or use a larger-context model.`
                : `This turn would fill ~${pctRounded}% of the ${ctxK}k context window. Consider splitting the document.`;
        }
    }

    return {
        estimatedTokens,
        estimatedTokensHigh,
        textTokens,
        estimatedSessionPct,
        estimatedSessionPctHigh,
        projectedTotalPct,
        modelComparisons,
        warning,
        attachmentBreakdown,
        attachmentWarnings,
        hasUnknownImage,
        hasPdf,
        projectedContextPctLow,
        projectedContextPctHigh,
        contextWindowSize,
        contextOverrunWarning,
    };
}
