// tests/unit/topic-hint.test.ts
// Tests for the topic hint extraction logic inlined in inject.ts (lines 362-381).
// Mirrors extractHint() so it can run in Node without a browser runtime.

import { describe, it, expect } from 'vitest';

// -- Mirrored extractHint from inject.ts --

const MAX = 120;
const SKIP = /^(hey|hi|hello|thanks|thank you|ok|okay|sure|yes|no|great|awesome|perfect|cool|nice|got it|sounds good)\b/i;

function extractHint(text: string): string {
    if (!text) return '';
    const lines = text.split('\n');
    let inCode = false;
    for (const raw of lines) {
        const ln = raw.trim();
        if (ln.startsWith('```')) { inCode = !inCode; continue; }
        if (inCode) continue;
        if (ln.length < 10) continue;
        if (SKIP.test(ln)) continue;
        return ln.length > MAX ? ln.slice(0, MAX) + '...' : ln;
    }
    for (const raw of lines) {
        const ln = raw.trim();
        if (ln.length > 0 && !ln.startsWith('```')) return ln.length > MAX ? ln.slice(0, MAX) + '...' : ln;
    }
    return '';
}

// -- Tests --

describe('extractHint', () => {
    // ── Basic behavior ───────────────────────────────────────────────────

    it('returns empty string for empty input', () => {
        expect(extractHint('')).toBe('');
    });

    it('returns empty string for undefined-like input', () => {
        // The production code guards with `if (!text)`, which catches empty string
        expect(extractHint('')).toBe('');
    });

    it('returns the first qualifying line', () => {
        expect(extractHint('Can you help me write a React component?')).toBe(
            'Can you help me write a React component?',
        );
    });

    it('returns the line trimmed of leading/trailing whitespace', () => {
        expect(extractHint('   Can you help me write a React component?   ')).toBe(
            'Can you help me write a React component?',
        );
    });

    // ── Short line filtering ─────────────────────────────────────────────

    it('skips lines shorter than 10 characters', () => {
        const input = 'hey\nshort\nCan you help me write a function?';
        expect(extractHint(input)).toBe('Can you help me write a function?');
    });

    it('falls back to first non-empty line when all are short or greetings', () => {
        // First pass: all lines < 10 chars or greeting prefix -> nothing qualifies
        // Fallback pass: returns "hi" (first non-empty, non-code-fence line)
        expect(extractHint('hi\nok\nyes')).toBe('hi');
    });

    // ── Greeting prefix filtering ────────────────────────────────────────

    it('skips lines starting with "hey"', () => {
        expect(extractHint('hey there, how are you\nCan you build a dashboard?')).toBe(
            'Can you build a dashboard?',
        );
    });

    it('skips lines starting with "hi"', () => {
        expect(extractHint('hi claude, what is up\nPlease review this code for me')).toBe(
            'Please review this code for me',
        );
    });

    it('skips lines starting with "hello"', () => {
        expect(extractHint('hello world how are you doing\nImplement the search feature')).toBe(
            'Implement the search feature',
        );
    });

    it('skips lines starting with "thanks"', () => {
        expect(extractHint('thanks for the help earlier\nNow fix the login bug please')).toBe(
            'Now fix the login bug please',
        );
    });

    it('skips lines starting with "thank you"', () => {
        expect(extractHint('thank you for your help\nRefactor the auth module')).toBe(
            'Refactor the auth module',
        );
    });

    it('skips "ok", "okay", "sure", "yes", "no"', () => {
        const input = [
            'ok that makes sense',
            'okay I understand now',
            'sure thing lets proceed',
            'yes I agree with that',
            'no that is not right',
            'Write me a Python script to parse CSV',
        ].join('\n');
        expect(extractHint(input)).toBe('Write me a Python script to parse CSV');
    });

    it('skips "great", "awesome", "perfect", "cool", "nice"', () => {
        const input = [
            'great work on that feature',
            'awesome that looks fantastic',
            'perfect that is exactly right',
            'cool I like that approach',
            'nice job on the implementation',
            'Build a REST API with Express',
        ].join('\n');
        expect(extractHint(input)).toBe('Build a REST API with Express');
    });

    it('skips "got it" and "sounds good"', () => {
        const input = 'got it I understand now\nsounds good lets move on\nDeploy the app to production';
        expect(extractHint(input)).toBe('Deploy the app to production');
    });

    it('is case-insensitive on greeting prefixes', () => {
        expect(extractHint('HEY there my friend\nBuild a Chrome extension')).toBe(
            'Build a Chrome extension',
        );
        expect(extractHint('Hello World from Claude\nImplement dark mode toggle')).toBe(
            'Implement dark mode toggle',
        );
    });

    it('does not skip a line where greeting word is not at the start', () => {
        // "say hello to the world" does not start with a greeting prefix
        expect(extractHint('I want to say hello to the world from my app')).toBe(
            'I want to say hello to the world from my app',
        );
    });

    // ── Code block filtering ─────────────────────────────────────────────

    it('skips lines inside code blocks', () => {
        const input = [
            '```typescript',
            'function add(a: number, b: number): number { return a + b; }',
            '```',
            'Can you optimize this function for performance?',
        ].join('\n');
        expect(extractHint(input)).toBe('Can you optimize this function for performance?');
    });

    it('handles multiple code blocks', () => {
        const input = [
            '```',
            'const x = 1;',
            '```',
            '```',
            'const y = 2;',
            '```',
            'Merge these two code snippets together',
        ].join('\n');
        expect(extractHint(input)).toBe('Merge these two code snippets together');
    });

    it('skips all content when entirely inside a code block', () => {
        const input = [
            '```',
            'function longFunctionName() { return 42; }',
            'const anotherLongLine = "this is very long enough"',
        ].join('\n');
        // Fallback pass: returns the code fence line? No, code fences are skipped.
        // The function content is non-empty, non-fence, so fallback returns it.
        // But wait: inCode is true, first pass skips them. Second pass (fallback)
        // does not check inCode, so it returns the first non-empty, non-fence line.
        expect(extractHint(input)).toBe('function longFunctionName() { return 42; }');
    });

    // ── Truncation ───────────────────────────────────────────────────────

    it('truncates lines longer than 120 characters', () => {
        const longLine = 'A'.repeat(150);
        expect(extractHint(longLine)).toBe('A'.repeat(120) + '...');
    });

    it('does not truncate lines at exactly 120 characters', () => {
        const exact = 'B'.repeat(120);
        expect(extractHint(exact)).toBe(exact);
    });

    it('truncates at 121 characters', () => {
        const line = 'C'.repeat(121);
        expect(extractHint(line)).toBe('C'.repeat(120) + '...');
    });

    // ── Fallback pass ────────────────────────────────────────────────────

    it('falls back to the first non-empty, non-code-fence line when all are filtered', () => {
        // All lines are either short or greetings, but the fallback pass
        // picks the first non-empty line regardless of length/content.
        const input = 'hey\nok\nhi there';
        // "hey" is 3 chars (non-empty, non-code-fence) -> returned by fallback
        expect(extractHint(input)).toBe('hey');
    });

    it('skips code fence lines in fallback pass', () => {
        const input = '```\nshort';
        expect(extractHint(input)).toBe('short');
    });

    it('returns empty when all lines are code fences', () => {
        expect(extractHint('```\n```\n```')).toBe('');
    });

    it('falls back applies truncation', () => {
        // First pass: all lines < 10 chars. Fallback picks the first non-empty line.
        // But the fallback line itself might be long if it was skipped for a different reason.
        const input = 'hey\n' + 'D'.repeat(200);
        // First pass: "hey" is < 10 chars, "DDD..." is not a greeting, length >= 10 -> qualifies!
        // So actually the first pass returns the long line, truncated.
        expect(extractHint(input)).toBe('D'.repeat(120) + '...');
    });

    // ── Mixed scenarios ──────────────────────────────────────────────────

    it('handles a realistic multi-line prompt', () => {
        const input = [
            'hey claude',
            '',
            '```python',
            'def fibonacci(n):',
            '    if n <= 1: return n',
            '    return fibonacci(n-1) + fibonacci(n-2)',
            '```',
            '',
            'Can you convert this recursive fibonacci to iterative?',
            'Also add type hints and a docstring.',
        ].join('\n');
        expect(extractHint(input)).toBe(
            'Can you convert this recursive fibonacci to iterative?',
        );
    });

    it('handles prompt with only whitespace lines', () => {
        expect(extractHint('   \n  \n    ')).toBe('');
    });

    it('handles single qualifying line', () => {
        expect(extractHint('Explain the difference between let and const in JavaScript')).toBe(
            'Explain the difference between let and const in JavaScript',
        );
    });
});
