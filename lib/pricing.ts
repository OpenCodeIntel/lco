// lib/pricing.ts
// Model pricing lookup and cost calculation.
// All costs are in USD, per individual token (not per million).

import pricingData from '../assets/pricing.json';

interface ModelPricing {
    inputCostPerToken: number;
    outputCostPerToken: number;
    contextWindow: number;
}

const PRICING_MAP = pricingData as Record<string, ModelPricing>;

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Returns pricing data for the given model name, or null if the model is unknown.
 * Lookup is case-insensitive.
 */
export function lookupModel(modelName: string): ModelPricing | null {
    if (!modelName) return null;
    return PRICING_MAP[modelName] ?? PRICING_MAP[modelName.toLowerCase()] ?? null;
}

/**
 * Calculates the estimated USD cost for a request.
 * Returns null if the model is not in the pricing table. Never throws.
 */
export function calculateCost(
    inputTokens: number,
    outputTokens: number,
    model: string,
): number | null {
    if (inputTokens < 0 || outputTokens < 0) return null;
    const pricing = lookupModel(model);
    if (!pricing) return null;
    return inputTokens * pricing.inputCostPerToken + outputTokens * pricing.outputCostPerToken;
}

/**
 * Returns the context window size for the given model.
 * Falls back to 200,000 for unknown models.
 */
export function getContextWindowSize(model: string): number {
    return lookupModel(model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}
