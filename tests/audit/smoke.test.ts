import { describe, test, expect } from 'vitest';

// Smoke test: validate that lib/ modules are importable and callable from the audit test directory.

import { calculateCost, lookupModel, getContextWindowSize } from '../../lib/pricing';
import { formatTokens, formatCost, formatModel } from '../../lib/format';
import { computeHealthScore } from '../../lib/health-score';
import { isValidBridgeSchema } from '../../lib/bridge-validation';
import { analyzeContext, pickTopSignal, signalKey } from '../../lib/context-intelligence';
import { analyzeDelta } from '../../lib/delta-coaching';
import { analyzePrompt, classifyModelTier } from '../../lib/prompt-analysis';
import { computePreSubmitEstimate } from '../../lib/pre-submit';
import { computeTokenEconomics } from '../../lib/token-economics';
import { classifyZone } from '../../lib/usage-budget';
import { INITIAL_STATE, applyTokenBatch } from '../../lib/overlay-state';
import { extractConversationId, extractOrganizationId, extractTopicHint, todayDateString, isoWeekId } from '../../lib/conversation-store';
import { buildHandoffSummary, deduplicateHints } from '../../lib/handoff-summary';

describe('smoke: imports resolve and basic calls succeed', () => {
    test('pricing: lookupModel returns data for known model', () => {
        const result = lookupModel('claude-sonnet-4-6');
        expect(result).not.toBeNull();
        expect(result!.inputCostPerToken).toBeGreaterThan(0);
    });

    test('pricing: calculateCost returns a number for known model', () => {
        const cost = calculateCost(1000, 500, 'claude-sonnet-4-6');
        expect(typeof cost).toBe('number');
        expect(cost).toBeGreaterThan(0);
    });

    test('format: formatTokens returns a string', () => {
        expect(formatTokens(1234)).toBe('1.2k');
    });

    test('format: formatCost handles null', () => {
        expect(formatCost(null)).toBe('$0.00*');
    });

    test('health-score: computeHealthScore returns valid shape', () => {
        const result = computeHealthScore({ contextPct: 10, turnCount: 2, growthRate: null });
        expect(result.level).toBe('healthy');
        expect(typeof result.label).toBe('string');
        expect(typeof result.coaching).toBe('string');
    });

    test('bridge-validation: rejects empty object', () => {
        expect(isValidBridgeSchema({})).toBe(false);
    });

    test('context-intelligence: analyzeContext returns array', () => {
        const signals = analyzeContext({
            turnCount: 1, contextPct: 10, contextHistory: [10], model: 'claude-sonnet-4-6', contextWindow: 200000,
        });
        expect(Array.isArray(signals)).toBe(true);
    });

    test('delta-coaching: analyzeDelta returns array', () => {
        const signals = analyzeDelta({
            currentDelta: null, recentDeltas: [], sessionPct: 0, firstTurnDelta: null, turnCount: 0,
        });
        expect(Array.isArray(signals)).toBe(true);
    });

    test('prompt-analysis: classifyModelTier recognizes sonnet', () => {
        const tier = classifyModelTier('claude-sonnet-4-6');
        expect(tier).not.toBeNull();
        expect(tier!.tier).toBe('sonnet');
    });

    test('pre-submit: returns null for short draft', () => {
        expect(computePreSubmitEstimate({ draftCharCount: 5, model: 'claude-sonnet-4-6', pctPerInputToken: null, currentSessionPct: 10 })).toBeNull();
    });

    test('token-economics: returns empty maps for empty input', () => {
        const result = computeTokenEconomics([]);
        expect(result.medianTokensPer1Pct.size).toBe(0);
    });

    test('usage-budget: classifyZone returns comfortable for low pct', () => {
        expect(classifyZone(10)).toBe('comfortable');
    });

    test('overlay-state: applyTokenBatch returns new state', () => {
        const next = applyTokenBatch(INITIAL_STATE, { inputTokens: 100, outputTokens: 50, model: 'claude-sonnet-4-6' });
        expect(next.streaming).toBe(true);
        expect(next.lastRequest).not.toBeNull();
    });

    test('conversation-store: extractConversationId parses chat URL', () => {
        const id = extractConversationId('https://claude.ai/chat/12345678-1234-1234-1234-123456789abc');
        expect(id).toBe('12345678-1234-1234-1234-123456789abc');
    });

    test('handoff-summary: deduplicateHints removes duplicates', () => {
        const result = deduplicateHints(['Hello world this is a long test', 'Hello world this is a long test but different']);
        expect(result).toHaveLength(1);
    });
});
