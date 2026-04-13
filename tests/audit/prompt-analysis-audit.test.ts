import { describe, test, expect } from 'vitest';

// Audit: lib/prompt-analysis.ts - model tier classification, coaching signals

import {
    analyzePrompt,
    classifyModelTier,
    MODEL_TIERS,
    LARGE_PASTE_MIN_CHARS,
    SHORT_FOLLOWUP_MAX_CHARS,
    FOLLOWUP_CHAIN_MIN_COUNT,
    type PromptCharacteristics,
    type DeltaPromptContext,
} from '../../lib/prompt-analysis';

// ── classifyModelTier ──────────────────────────────────────────────────────

describe('classifyModelTier', () => {
    test('opus prefix returns opus tier', () => {
        expect(classifyModelTier('claude-opus-4-6-20250514')).toEqual({ tier: 'opus', label: 'Opus' });
    });

    test('sonnet prefix returns sonnet tier', () => {
        expect(classifyModelTier('claude-sonnet-4-6')).toEqual({ tier: 'sonnet', label: 'Sonnet' });
    });

    test('haiku prefix returns haiku tier', () => {
        expect(classifyModelTier('claude-haiku-4-5')).toEqual({ tier: 'haiku', label: 'Haiku' });
    });

    test('unknown model returns null', () => {
        expect(classifyModelTier('gpt-4o')).toBeNull();
    });

    test('empty string returns null', () => {
        expect(classifyModelTier('')).toBeNull();
    });

    test('partial prefix does not match', () => {
        expect(classifyModelTier('claude-op')).toBeNull();
    });
});

// ── model_suggestion signal ────────────────────────────────────────────────

describe('analyzePrompt: model_suggestion', () => {
    test('fires for short no-code prompt on Opus (generic)', () => {
        const signals = analyzePrompt(
            { promptLength: 50, hasCodeBlock: false, isShortFollowUp: true },
            'claude-opus-4-6',
            0,
        );
        const ms = signals.filter(s => s.type === 'model_suggestion');
        expect(ms).toHaveLength(1);
        expect(ms[0].message).toMatch(/5x lower cost/);
    });

    test('does not fire for Opus with code block', () => {
        const signals = analyzePrompt(
            { promptLength: 50, hasCodeBlock: true, isShortFollowUp: false },
            'claude-opus-4-6',
            0,
        );
        expect(signals.filter(s => s.type === 'model_suggestion')).toHaveLength(0);
    });

    test('does not fire for Opus with long prompt (>= 200)', () => {
        const signals = analyzePrompt(
            { promptLength: 200, hasCodeBlock: false, isShortFollowUp: false },
            'claude-opus-4-6',
            0,
        );
        expect(signals.filter(s => s.type === 'model_suggestion')).toHaveLength(0);
    });

    test('does not fire for Sonnet without delta context', () => {
        const signals = analyzePrompt(
            { promptLength: 50, hasCodeBlock: false, isShortFollowUp: true },
            'claude-sonnet-4-6',
            0,
        );
        expect(signals.filter(s => s.type === 'model_suggestion')).toHaveLength(0);
    });

    test('fires for Sonnet with delta context', () => {
        const delta: DeltaPromptContext = { currentDelta: 3.5, haikuMedianDelta: 0.8 };
        const signals = analyzePrompt(
            { promptLength: 50, hasCodeBlock: false, isShortFollowUp: true },
            'claude-sonnet-4-6',
            0,
            delta,
        );
        const ms = signals.filter(s => s.type === 'model_suggestion');
        expect(ms).toHaveLength(1);
        expect(ms[0].message).toMatch(/3\.5%/);
        expect(ms[0].message).toMatch(/0\.8%/);
    });

    test('fires for Opus with delta context (uses delta message)', () => {
        const delta: DeltaPromptContext = { currentDelta: 5.2, haikuMedianDelta: 1.0 };
        const signals = analyzePrompt(
            { promptLength: 50, hasCodeBlock: false, isShortFollowUp: true },
            'claude-opus-4-6',
            0,
            delta,
        );
        const ms = signals.filter(s => s.type === 'model_suggestion');
        expect(ms).toHaveLength(1);
        expect(ms[0].message).toMatch(/5\.2%/);
    });

    test('does not fire for Haiku', () => {
        const signals = analyzePrompt(
            { promptLength: 50, hasCodeBlock: false, isShortFollowUp: true },
            'claude-haiku-4-5',
            0,
        );
        expect(signals.filter(s => s.type === 'model_suggestion')).toHaveLength(0);
    });

    test('does not fire for unknown model', () => {
        const signals = analyzePrompt(
            { promptLength: 50, hasCodeBlock: false, isShortFollowUp: true },
            'unknown-model',
            0,
        );
        expect(signals.filter(s => s.type === 'model_suggestion')).toHaveLength(0);
    });

    // Verify the "5x" claim: Opus input is $5/M, Haiku is $1/M -> 5x ratio
    test('"5x lower cost" claim is accurate for input pricing', async () => {
        const { lookupModel } = await import('../../lib/pricing');
        const opus = lookupModel('claude-opus-4-6')!;
        const haiku = lookupModel('claude-haiku-4-5')!;
        const inputRatio = opus.inputCostPerToken / haiku.inputCostPerToken;
        expect(inputRatio).toBeCloseTo(5, 10);
    });
});

// ── large_paste signal ─────────────────────────────────────────────────────

describe('analyzePrompt: large_paste', () => {
    test('fires for code block with >= 500 chars', () => {
        const signals = analyzePrompt(
            { promptLength: 500, hasCodeBlock: true, isShortFollowUp: false },
            'claude-sonnet-4-6',
            0,
        );
        const lp = signals.filter(s => s.type === 'large_paste');
        expect(lp).toHaveLength(1);
    });

    test('does not fire below 500 chars', () => {
        const signals = analyzePrompt(
            { promptLength: 499, hasCodeBlock: true, isShortFollowUp: false },
            'claude-sonnet-4-6',
            0,
        );
        expect(signals.filter(s => s.type === 'large_paste')).toHaveLength(0);
    });

    test('does not fire without code block', () => {
        const signals = analyzePrompt(
            { promptLength: 1000, hasCodeBlock: false, isShortFollowUp: false },
            'claude-sonnet-4-6',
            0,
        );
        expect(signals.filter(s => s.type === 'large_paste')).toHaveLength(0);
    });

    test('token estimate is approx chars/4', () => {
        const signals = analyzePrompt(
            { promptLength: 800, hasCodeBlock: true, isShortFollowUp: false },
            'claude-sonnet-4-6',
            0,
        );
        const lp = signals.find(s => s.type === 'large_paste');
        expect(lp!.message).toMatch(/~200 tokens/);
    });
});

// ── follow_up_chain signal ─────────────────────────────────────────────────

describe('analyzePrompt: follow_up_chain', () => {
    test('fires at exactly 3 consecutive short follow-ups', () => {
        const signals = analyzePrompt(
            { promptLength: 30, hasCodeBlock: false, isShortFollowUp: true },
            'claude-sonnet-4-6',
            3,
        );
        expect(signals.filter(s => s.type === 'follow_up_chain')).toHaveLength(1);
    });

    test('does not fire below 3', () => {
        const signals = analyzePrompt(
            { promptLength: 30, hasCodeBlock: false, isShortFollowUp: true },
            'claude-sonnet-4-6',
            2,
        );
        expect(signals.filter(s => s.type === 'follow_up_chain')).toHaveLength(0);
    });

    test('message includes the count', () => {
        const signals = analyzePrompt(
            { promptLength: 30, hasCodeBlock: false, isShortFollowUp: true },
            'claude-sonnet-4-6',
            5,
        );
        const fc = signals.find(s => s.type === 'follow_up_chain');
        expect(fc!.message).toMatch(/5 short follow-ups/);
    });
});

// ── All signals are info severity ──────────────────────────────────────────

describe('severity invariant', () => {
    test('all prompt analysis signals are info severity', () => {
        // Trigger all three signal types
        const delta: DeltaPromptContext = { currentDelta: 5.2, haikuMedianDelta: 1.0 };
        const signals = analyzePrompt(
            { promptLength: 600, hasCodeBlock: true, isShortFollowUp: true },
            'claude-opus-4-6',
            3,
            delta,
        );
        // model_suggestion won't fire because hasCodeBlock is true. That's fine.
        for (const s of signals) {
            expect(s.severity).toBe('info');
        }
    });
});
