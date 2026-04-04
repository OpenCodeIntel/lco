// tests/unit/prompt-analysis.test.ts
// Full test suite for lib/prompt-analysis.ts.

import { describe, it, expect } from 'vitest';
import {
    classifyModelTier,
    analyzePrompt,
    LARGE_PASTE_MIN_CHARS,
    FOLLOWUP_CHAIN_MIN_COUNT,
    type PromptCharacteristics,
} from '../../lib/prompt-analysis';

// ── classifyModelTier ────────────────────────────────────────────────────────

describe('classifyModelTier', () => {
    it('returns opus tier for claude-opus-4-6-20250514', () => {
        const result = classifyModelTier('claude-opus-4-6-20250514');
        expect(result).not.toBeNull();
        expect(result!.tier).toBe('opus');
        expect(result!.label).toBe('Opus');
    });

    it('returns opus tier for claude-opus-4-6', () => {
        const result = classifyModelTier('claude-opus-4-6');
        expect(result).not.toBeNull();
        expect(result!.tier).toBe('opus');
    });

    it('returns sonnet tier for claude-sonnet-4-6', () => {
        const result = classifyModelTier('claude-sonnet-4-6');
        expect(result).not.toBeNull();
        expect(result!.tier).toBe('sonnet');
        expect(result!.label).toBe('Sonnet');
    });

    it('returns haiku tier for claude-haiku-4-5', () => {
        const result = classifyModelTier('claude-haiku-4-5');
        expect(result).not.toBeNull();
        expect(result!.tier).toBe('haiku');
        expect(result!.label).toBe('Haiku');
    });

    it('returns null for unknown-model', () => {
        expect(classifyModelTier('unknown-model')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(classifyModelTier('')).toBeNull();
    });

    it('returns null for partial match like "claude-" (no tier prefix match)', () => {
        expect(classifyModelTier('claude-')).toBeNull();
    });

    it('returns null for gpt-4o', () => {
        expect(classifyModelTier('gpt-4o')).toBeNull();
    });

    it('handles a future opus version with new suffix', () => {
        const result = classifyModelTier('claude-opus-5-0');
        expect(result).not.toBeNull();
        expect(result!.tier).toBe('opus');
    });
});

// ── analyzePrompt: model_suggestion ─────────────────────────────────────────

describe('analyzePrompt: model_suggestion', () => {
    const shortNoCode: PromptCharacteristics = {
        promptLength: 50,
        hasCodeBlock: false,
        isShortFollowUp: true,
    };

    it('fires for short no-code prompt on Opus', () => {
        const signals = analyzePrompt(shortNoCode, 'claude-opus-4-6', 0);
        const s = signals.find(x => x.type === 'model_suggestion');
        expect(s).toBeDefined();
    });

    it('does not fire for short no-code prompt on Sonnet', () => {
        const signals = analyzePrompt(shortNoCode, 'claude-sonnet-4-6', 0);
        expect(signals.find(x => x.type === 'model_suggestion')).toBeUndefined();
    });

    it('does not fire for short no-code prompt on Haiku', () => {
        const signals = analyzePrompt(shortNoCode, 'claude-haiku-4-5', 0);
        expect(signals.find(x => x.type === 'model_suggestion')).toBeUndefined();
    });

    it('does not fire for prompt at exactly 200 chars on Opus', () => {
        const chars: PromptCharacteristics = { promptLength: 200, hasCodeBlock: false, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-opus-4-6', 0);
        expect(signals.find(x => x.type === 'model_suggestion')).toBeUndefined();
    });

    it('fires for prompt at 199 chars on Opus', () => {
        const chars: PromptCharacteristics = { promptLength: 199, hasCodeBlock: false, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-opus-4-6', 0);
        expect(signals.find(x => x.type === 'model_suggestion')).toBeDefined();
    });

    it('does not fire for long prompt on Opus (>= 200 chars)', () => {
        const chars: PromptCharacteristics = { promptLength: 250, hasCodeBlock: false, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-opus-4-6', 0);
        expect(signals.find(x => x.type === 'model_suggestion')).toBeUndefined();
    });

    it('does not fire for prompt with code block on Opus even if short', () => {
        const chars: PromptCharacteristics = { promptLength: 50, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-opus-4-6', 0);
        expect(signals.find(x => x.type === 'model_suggestion')).toBeUndefined();
    });

    it('does not fire for unknown model', () => {
        const signals = analyzePrompt(shortNoCode, 'gpt-4o', 0);
        expect(signals.find(x => x.type === 'model_suggestion')).toBeUndefined();
    });

    it('has type model_suggestion, severity info, dismissible true', () => {
        const signals = analyzePrompt(shortNoCode, 'claude-opus-4-6', 0);
        const s = signals.find(x => x.type === 'model_suggestion')!;
        expect(s.type).toBe('model_suggestion');
        expect(s.severity).toBe('info');
        expect(s.dismissible).toBe(true);
    });

    it('message mentions Haiku and cost savings', () => {
        const signals = analyzePrompt(shortNoCode, 'claude-opus-4-6', 0);
        const s = signals.find(x => x.type === 'model_suggestion')!;
        expect(s.message).toContain('Haiku');
        expect(s.message).toContain('cost');
    });
});

// ── analyzePrompt: large_paste ───────────────────────────────────────────────

describe('analyzePrompt: large_paste', () => {
    it('fires for prompt >= 500 chars with code block', () => {
        const chars: PromptCharacteristics = { promptLength: 500, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        expect(signals.find(x => x.type === 'large_paste')).toBeDefined();
    });

    it('does not fire for prompt >= 500 chars without code block', () => {
        const chars: PromptCharacteristics = { promptLength: 600, hasCodeBlock: false, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        expect(signals.find(x => x.type === 'large_paste')).toBeUndefined();
    });

    it('does not fire for prompt < 500 chars with code block', () => {
        const chars: PromptCharacteristics = { promptLength: 300, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        expect(signals.find(x => x.type === 'large_paste')).toBeUndefined();
    });

    it('does not fire at exactly 499 chars with code block (boundary)', () => {
        const chars: PromptCharacteristics = { promptLength: LARGE_PASTE_MIN_CHARS - 1, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        expect(signals.find(x => x.type === 'large_paste')).toBeUndefined();
    });

    it('fires at exactly 500 chars with code block (boundary)', () => {
        const chars: PromptCharacteristics = { promptLength: LARGE_PASTE_MIN_CHARS, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        expect(signals.find(x => x.type === 'large_paste')).toBeDefined();
    });

    it('has type large_paste, severity info, dismissible true', () => {
        const chars: PromptCharacteristics = { promptLength: 500, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        const s = signals.find(x => x.type === 'large_paste')!;
        expect(s.type).toBe('large_paste');
        expect(s.severity).toBe('info');
        expect(s.dismissible).toBe(true);
    });

    it('message includes approximate token count', () => {
        const chars: PromptCharacteristics = { promptLength: 800, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        const s = signals.find(x => x.type === 'large_paste')!;
        // 800 / 4 = 200 tokens
        expect(s.message).toContain('200');
        expect(s.message).toContain('tokens');
    });

    it('rounds token estimate correctly', () => {
        // 501 chars -> Math.round(501 / 4) = 125
        const chars: PromptCharacteristics = { promptLength: 501, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        const s = signals.find(x => x.type === 'large_paste')!;
        expect(s.message).toContain('125');
    });
});

// ── analyzePrompt: follow_up_chain ───────────────────────────────────────────

describe('analyzePrompt: follow_up_chain', () => {
    const noCode: PromptCharacteristics = { promptLength: 20, hasCodeBlock: false, isShortFollowUp: true };

    it('fires when recentShortFollowUps >= 3', () => {
        const signals = analyzePrompt(noCode, 'claude-sonnet-4-6', 3);
        expect(signals.find(x => x.type === 'follow_up_chain')).toBeDefined();
    });

    it('does not fire when recentShortFollowUps === 2', () => {
        const signals = analyzePrompt(noCode, 'claude-sonnet-4-6', 2);
        expect(signals.find(x => x.type === 'follow_up_chain')).toBeUndefined();
    });

    it('does not fire when recentShortFollowUps === 0', () => {
        const signals = analyzePrompt(noCode, 'claude-sonnet-4-6', 0);
        expect(signals.find(x => x.type === 'follow_up_chain')).toBeUndefined();
    });

    it('fires at exactly 3 (boundary)', () => {
        const signals = analyzePrompt(noCode, 'claude-sonnet-4-6', FOLLOWUP_CHAIN_MIN_COUNT);
        expect(signals.find(x => x.type === 'follow_up_chain')).toBeDefined();
    });

    it('fires for higher counts', () => {
        const signals = analyzePrompt(noCode, 'claude-sonnet-4-6', 10);
        expect(signals.find(x => x.type === 'follow_up_chain')).toBeDefined();
    });

    it('has type follow_up_chain, severity info, dismissible true', () => {
        const signals = analyzePrompt(noCode, 'claude-sonnet-4-6', 3);
        const s = signals.find(x => x.type === 'follow_up_chain')!;
        expect(s.type).toBe('follow_up_chain');
        expect(s.severity).toBe('info');
        expect(s.dismissible).toBe(true);
    });

    it('message includes the count of follow-ups', () => {
        const signals = analyzePrompt(noCode, 'claude-sonnet-4-6', 5);
        const s = signals.find(x => x.type === 'follow_up_chain')!;
        expect(s.message).toContain('5');
    });
});

// ── analyzePrompt: multiple signals and empty results ───────────────────────

describe('analyzePrompt: multiple signals', () => {
    it('can produce model_suggestion and follow_up_chain simultaneously', () => {
        // Short prompt on Opus (model_suggestion) + 3rd short follow-up (follow_up_chain)
        const chars: PromptCharacteristics = { promptLength: 30, hasCodeBlock: false, isShortFollowUp: true };
        const signals = analyzePrompt(chars, 'claude-opus-4-6', 3);
        expect(signals.find(x => x.type === 'model_suggestion')).toBeDefined();
        expect(signals.find(x => x.type === 'follow_up_chain')).toBeDefined();
    });

    it('cannot produce model_suggestion and large_paste simultaneously', () => {
        // model_suggestion requires promptLength < 200 + no code block
        // large_paste requires promptLength >= 500 + has code block
        // These are mutually exclusive by definition
        const shortNoCode: PromptCharacteristics = { promptLength: 50, hasCodeBlock: false, isShortFollowUp: true };
        const signals = analyzePrompt(shortNoCode, 'claude-opus-4-6', 0);
        expect(signals.find(x => x.type === 'model_suggestion')).toBeDefined();
        expect(signals.find(x => x.type === 'large_paste')).toBeUndefined();

        const longWithCode: PromptCharacteristics = { promptLength: 600, hasCodeBlock: true, isShortFollowUp: false };
        const signals2 = analyzePrompt(longWithCode, 'claude-opus-4-6', 0);
        expect(signals2.find(x => x.type === 'large_paste')).toBeDefined();
        expect(signals2.find(x => x.type === 'model_suggestion')).toBeUndefined();
    });

    it('returns empty array when no conditions are met', () => {
        const chars: PromptCharacteristics = { promptLength: 300, hasCodeBlock: false, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        expect(signals).toHaveLength(0);
    });

    it('all three signals can fire simultaneously when conditions overlap', () => {
        // large_paste fires (code + 500+ chars)
        // follow_up_chain fires (>= 3 short follow-ups)
        // model_suggestion cannot fire alongside large_paste (code block prevents it)
        // So max is 2: large_paste + follow_up_chain
        const chars: PromptCharacteristics = { promptLength: 600, hasCodeBlock: true, isShortFollowUp: true };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 4);
        expect(signals.find(x => x.type === 'large_paste')).toBeDefined();
        expect(signals.find(x => x.type === 'follow_up_chain')).toBeDefined();
    });
});
