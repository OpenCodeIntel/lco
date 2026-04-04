// lib/prompt-analysis.ts
// Prompt Agent: analyzes per-turn prompt characteristics and returns coaching signals.
// No DOM refs, no chrome APIs, no side effects. Pure functions only.
//
// ── Role in the multi-agent architecture ────────────────────────────────────
//
// Each lib/ module is an agent with a single responsibility and a clean interface.
// The content script (claude-ai.content.ts) is the orchestrator that wires agents.
//
// | Agent             | Module                   | Input                        | Output           |
// |-------------------|--------------------------|------------------------------|------------------|
// | Intelligence Agent| context-intelligence.ts  | ConversationState            | ContextSignal[]  |
// | Health Agent      | health-score.ts          | contextPct, turnCount, rate  | HealthScore      |
// | Pricing Agent     | pricing.ts               | model, tokens                | cost (USD)       |
// | Memory Agent      | conversation-store.ts    | conversationId, turn data    | ConversationRecord|
// | **Prompt Agent**  | **prompt-analysis.ts**   | **PromptCharacteristics**    | **ContextSignal[]**|
//
// The Prompt Agent and the Intelligence Agent share the same output type
// (ContextSignal[]). The content script merges their outputs before calling
// pickTopSignal(). This means prompt coaching signals participate in the
// existing severity-ranked priority system with zero UI changes.
//
// ── Agent contract ──────────────────────────────────────────────────────────
//
// Input:  PromptCharacteristics (extracted by inject.ts, carried on STREAM_COMPLETE)
//         + model name (string)
//         + recentShortFollowUps count (tracked by the content script)
// Output: ContextSignal[] with types: model_suggestion, large_paste, follow_up_chain
// All output signals have severity 'info'. Context health signals (warning/critical)
// always win in pickTopSignal. Prompt coaching only shows when the conversation
// is healthy. This is by design, not by accident.
//
// ── Data flow ───────────────────────────────────────────────────────────────
//
// inject.ts (MAIN world) extracts three prompt characteristics from promptText:
//   promptLength  = promptText.length
//   hasCodeBlock  = promptText.includes('```')
//   isShortFollowUp = length > 0 && length < SHORT_FOLLOWUP_MAX_CHARS
//
// These ride the STREAM_COMPLETE payload as optional fields. inject.ts cannot
// import from lib/, so the thresholds are duplicated inline. The constants
// below are the canonical source of truth; inject.ts mirrors them.
//
// The content script receives the payload, builds PromptCharacteristics,
// and calls analyzePrompt(). No prompt text is persisted or leaves the tab.
// ────────────────────────────────────────────────────────────────────────────

import type { ContextSignal } from './context-intelligence';

// ── Types ───────────────────────────────────────────────────────────────────

/** Prompt characteristics extracted by inject.ts and carried on STREAM_COMPLETE. */
export interface PromptCharacteristics {
    promptLength: number;
    hasCodeBlock: boolean;
    isShortFollowUp: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Minimum prompt length (chars) to consider a code block "large". */
export const LARGE_PASTE_MIN_CHARS = 500;

/**
 * Maximum prompt length (chars) to qualify as a short follow-up.
 * Canonical source of truth. inject.ts duplicates this value inline
 * because it cannot import from lib/. Keep both in sync.
 */
export const SHORT_FOLLOWUP_MAX_CHARS = 50;

/** Number of consecutive short follow-ups required to trigger the chain signal. */
export const FOLLOWUP_CHAIN_MIN_COUNT = 3;

// ── Model classification ────────────────────────────────────────────────────

/**
 * Model tier map. Keys are model name prefixes.
 * Tiers: 'opus' (expensive), 'sonnet' (mid), 'haiku' (cheap).
 */
export const MODEL_TIERS: Record<string, { tier: string; label: string }> = {
    'claude-opus': { tier: 'opus', label: 'Opus' },
    'claude-sonnet': { tier: 'sonnet', label: 'Sonnet' },
    'claude-haiku': { tier: 'haiku', label: 'Haiku' },
};

/**
 * Returns the tier for a model name, or null if unrecognized.
 * Matches by prefix so version suffixes are handled transparently:
 * 'claude-opus-4-6-20250514' -> { tier: 'opus', label: 'Opus' }.
 */
export function classifyModelTier(model: string): { tier: string; label: string } | null {
    for (const prefix of Object.keys(MODEL_TIERS)) {
        if (model.startsWith(prefix)) {
            return MODEL_TIERS[prefix];
        }
    }
    return null;
}

// ── Analysis ────────────────────────────────────────────────────────────────

/**
 * Analyze prompt characteristics and recent conversation state to produce
 * prompt-level coaching signals.
 *
 * @param chars - Prompt characteristics from the current turn
 * @param model - Model name used for this turn
 * @param recentShortFollowUps - Count of consecutive short follow-ups ending
 *   with this turn (caller tracks this across turns)
 * @returns ContextSignal[] with types model_suggestion, large_paste, follow_up_chain
 */
export function analyzePrompt(
    chars: PromptCharacteristics,
    model: string,
    recentShortFollowUps: number,
): ContextSignal[] {
    const signals: ContextSignal[] = [];

    // 1. model_suggestion: short, no-code prompt on Opus -> suggest Haiku.
    // Only fires for Opus; savings from Sonnet to Haiku are less dramatic.
    const tier = classifyModelTier(model);
    if (
        tier !== null &&
        tier.tier === 'opus' &&
        chars.promptLength < 200 &&
        !chars.hasCodeBlock
    ) {
        signals.push({
            type: 'model_suggestion',
            severity: 'info',
            message: `Simple question detected on ${tier.label}. Haiku could handle this at ~5x lower cost.`,
            dismissible: true,
        });
    }

    // 2. large_paste: code block with substantial surrounding context.
    if (chars.hasCodeBlock && chars.promptLength >= LARGE_PASTE_MIN_CHARS) {
        const approxTokens = Math.round(chars.promptLength / 4);
        signals.push({
            type: 'large_paste',
            severity: 'info',
            message: `Large code block detected (~${approxTokens} tokens). Share only the relevant section to save context.`,
            dismissible: true,
        });
    }

    // 3. follow_up_chain: repeated terse messages -> suggest combining.
    if (recentShortFollowUps >= FOLLOWUP_CHAIN_MIN_COUNT) {
        signals.push({
            type: 'follow_up_chain',
            severity: 'info',
            message: `${recentShortFollowUps} short follow-ups in a row. Combining them into one message reduces context overhead.`,
            dismissible: true,
        });
    }

    return signals;
}
