// lib/prompt-analysis.ts
// Prompt Agent: pure functions that analyze per-turn prompt characteristics
// and return coaching signals. No DOM, no chrome APIs, no side effects.

import type { ContextSignal } from './context-intelligence';

/** Prompt characteristics extracted from inject.ts via the STREAM_COMPLETE payload. */
export interface PromptCharacteristics {
    promptLength: number;
    hasCodeBlock: boolean;
    isShortFollowUp: boolean;
}

/** Minimum prompt length (chars) to consider a code block "large". */
export const LARGE_PASTE_MIN_CHARS = 500;

/** Maximum prompt length (chars) to qualify as a short follow-up. */
export const SHORT_FOLLOWUP_MAX_CHARS = 50;

/** Number of consecutive short follow-ups required to trigger the chain signal. */
export const FOLLOWUP_CHAIN_MIN_COUNT = 3;

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
