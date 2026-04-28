// tests/unit/prompt-analysis.test.ts
// Full test suite for lib/prompt-analysis.ts.

import { describe, it, expect } from 'vitest';
import {
    classifyModelTier,
    analyzePrompt,
    isDetailHeavy,
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
        const s = signals.find(x => x.type === 'model_suggestion');
        expect(s).toBeDefined();
        expect(s!.type).toBe('model_suggestion');
        expect(s!.severity).toBe('info');
        expect(s!.dismissible).toBe(true);
    });

    it('message mentions Haiku and cost savings', () => {
        const signals = analyzePrompt(shortNoCode, 'claude-opus-4-6', 0);
        const s = signals.find(x => x.type === 'model_suggestion');
        expect(s).toBeDefined();
        expect(s!.message).toContain('Haiku');
        expect(s!.message).toContain('cost');
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
        const s = signals.find(x => x.type === 'large_paste');
        expect(s).toBeDefined();
        expect(s!.type).toBe('large_paste');
        expect(s!.severity).toBe('info');
        expect(s!.dismissible).toBe(true);
    });

    it('message includes approximate token count', () => {
        const chars: PromptCharacteristics = { promptLength: 800, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        const s = signals.find(x => x.type === 'large_paste');
        expect(s).toBeDefined();
        // 800 / 4 = 200 tokens
        expect(s!.message).toContain('200');
        expect(s!.message).toContain('tokens');
    });

    it('rounds token estimate correctly', () => {
        // 501 chars -> Math.round(501 / 4) = 125
        const chars: PromptCharacteristics = { promptLength: 501, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 0);
        const s = signals.find(x => x.type === 'large_paste');
        expect(s).toBeDefined();
        expect(s!.message).toContain('125');
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
        const s = signals.find(x => x.type === 'follow_up_chain');
        expect(s).toBeDefined();
        expect(s!.type).toBe('follow_up_chain');
        expect(s!.severity).toBe('info');
        expect(s!.dismissible).toBe(true);
    });

    it('message includes the count of follow-ups', () => {
        const signals = analyzePrompt(noCode, 'claude-sonnet-4-6', 5);
        const s = signals.find(x => x.type === 'follow_up_chain');
        expect(s).toBeDefined();
        expect(s!.message).toContain('5');
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

    it('large_paste and follow_up_chain can fire simultaneously', () => {
        // model_suggestion cannot coexist with large_paste (code block prevents model_suggestion).
        const chars: PromptCharacteristics = { promptLength: 600, hasCodeBlock: true, isShortFollowUp: true };
        const signals = analyzePrompt(chars, 'claude-sonnet-4-6', 4);
        expect(signals.find(x => x.type === 'large_paste')).toBeDefined();
        expect(signals.find(x => x.type === 'follow_up_chain')).toBeDefined();
    });
});

// ── Delta-enhanced model_suggestion ──────────────────────────────────────────

describe('model_suggestion with delta data', () => {
    const shortPrompt: PromptCharacteristics = { promptLength: 30, hasCodeBlock: false, isShortFollowUp: true };

    it('includes session % when delta data is available on Opus', () => {
        const signals = analyzePrompt(shortPrompt, 'claude-opus-4-6', 1, {
            currentDelta: 3.2,
            haikuMedianDelta: 0.6,
        });
        const ms = signals.find(x => x.type === 'model_suggestion');
        expect(ms).toBeDefined();
        expect(ms!.message).toContain('3.2%');
        expect(ms!.message).toContain('0.6%');
        expect(ms!.message).toContain('Opus');
        expect(ms!.message).toContain('Haiku');
    });

    it('falls back to generic message when delta is undefined', () => {
        const signals = analyzePrompt(shortPrompt, 'claude-opus-4-6', 1);
        const ms = signals.find(x => x.type === 'model_suggestion');
        expect(ms).toBeDefined();
        expect(ms!.message).toContain('5x lower cost');
    });

    it('falls back to generic message when currentDelta is null', () => {
        const signals = analyzePrompt(shortPrompt, 'claude-opus-4-6', 1, {
            currentDelta: null,
            haikuMedianDelta: 0.6,
        });
        const ms = signals.find(x => x.type === 'model_suggestion');
        expect(ms).toBeDefined();
        expect(ms!.message).toContain('5x lower cost');
    });

    it('falls back to generic message when haikuMedianDelta is null', () => {
        const signals = analyzePrompt(shortPrompt, 'claude-opus-4-6', 1, {
            currentDelta: 3.2,
            haikuMedianDelta: null,
        });
        const ms = signals.find(x => x.type === 'model_suggestion');
        expect(ms).toBeDefined();
        expect(ms!.message).toContain('5x lower cost');
    });

    it('fires for Sonnet when delta data is available', () => {
        const signals = analyzePrompt(shortPrompt, 'claude-sonnet-4-6', 1, {
            currentDelta: 2.1,
            haikuMedianDelta: 0.4,
        });
        const ms = signals.find(x => x.type === 'model_suggestion');
        expect(ms).toBeDefined();
        expect(ms!.message).toContain('2.1%');
        expect(ms!.message).toContain('Sonnet');
        expect(ms!.message).toContain('Haiku');
    });

    it('does not fire for Sonnet without delta data', () => {
        const signals = analyzePrompt(shortPrompt, 'claude-sonnet-4-6', 1);
        const ms = signals.find(x => x.type === 'model_suggestion');
        expect(ms).toBeUndefined();
    });

    it('does not fire for Haiku (cheapest tier)', () => {
        const signals = analyzePrompt(shortPrompt, 'claude-haiku-4-5', 1, {
            currentDelta: 0.5,
            haikuMedianDelta: 0.5,
        });
        const ms = signals.find(x => x.type === 'model_suggestion');
        expect(ms).toBeUndefined();
    });

    it('does not fire for Opus with code block even with delta data', () => {
        const codePrompt: PromptCharacteristics = { promptLength: 30, hasCodeBlock: true, isShortFollowUp: false };
        const signals = analyzePrompt(codePrompt, 'claude-opus-4-6', 1, {
            currentDelta: 3.2,
            haikuMedianDelta: 0.6,
        });
        const ms = signals.find(x => x.type === 'model_suggestion');
        expect(ms).toBeUndefined();
    });
});

// ── DETAIL_HEAVY_KEYWORDS / inject.ts mirror drift guard ────────────────────
//
// inject.ts cannot import from lib/, so DETAIL_HEAVY_KEYWORDS is mirrored
// inline as `detailHeavyKeywords`. If the two ever drift, the warning
// threshold shifts at the bridge layer but not in lib (or vice versa),
// and the user sees inconsistent coaching. This test reads inject.ts as
// text and asserts every keyword on the lib side appears verbatim.

describe('inject.ts mirrors DETAIL_HEAVY_KEYWORDS', () => {
    it('contains every lib-side keyword as a string literal', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const injectPath = path.resolve(here, '../../entrypoints/inject.ts');
        const source = await fs.readFile(injectPath, 'utf8');
        // Re-import to avoid pulling in the whole lib through static deps.
        const { DETAIL_HEAVY_KEYWORDS } = await import('../../lib/prompt-analysis');
        for (const keyword of DETAIL_HEAVY_KEYWORDS) {
            expect(
                source.includes(`'${keyword}'`),
                `inject.ts is missing the mirrored keyword '${keyword}'`,
            ).toBe(true);
        }
    });
});

// ── isDetailHeavy ────────────────────────────────────────────────────────────

describe('isDetailHeavy', () => {
    it('returns false for empty input', () => {
        expect(isDetailHeavy('')).toBe(false);
    });

    it('returns false for casual prose', () => {
        expect(isDetailHeavy('how do I sort an array in python')).toBe(false);
        expect(isDetailHeavy('any thoughts on the pricing model?')).toBe(false);
        expect(isDetailHeavy('all good?')).toBe(false);
    });

    it('returns true when the prompt contains a fenced code block', () => {
        expect(isDetailHeavy('here is the code:\n```ts\nconst x = 1;\n```')).toBe(true);
    });

    it('returns true for precision keywords (case-insensitive)', () => {
        expect(isDetailHeavy('give me the exact bytes')).toBe(true);
        expect(isDetailHeavy('Quote it VERBATIM please')).toBe(true);
        expect(isDetailHeavy('precise reproduction needed')).toBe(true);
    });

    it('returns true for compound triggers like "list every"', () => {
        expect(isDetailHeavy('list every parameter we discussed')).toBe(true);
        expect(isDetailHeavy('full list of files touched')).toBe(true);
    });

    it('does not over-trigger on the bare word "all" or "every"', () => {
        // Bare "all" and "every" appear constantly in prose and would
        // flood the warning if treated as triggers on their own.
        expect(isDetailHeavy('I tried all the suggestions')).toBe(false);
        expect(isDetailHeavy('every user reports the same bug')).toBe(false);
    });
});
