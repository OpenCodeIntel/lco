// tests/unit/inject-non-sse.test.ts
// Two test groups:
//
// 1) Semantic tests for shouldTeeAndDecode() in lib/sse-gate.ts — the
//    canonical predicate that decides whether the fetch interceptor in
//    entrypoints/inject.ts tees + decodes a response.
//
// 2) A source-text fingerprint guard. inject.ts runs in MAIN world and
//    cannot import from lib/, so it mirrors the predicate inline. The
//    guard reads inject.ts as text and asserts the mirror still matches
//    the canonical fingerprint substrings. Without it, the inline copy
//    could silently drift while the semantic tests below keep passing.
//
// Background on why the gate exists: claude.ai's completion endpoint
// returns 429 (rate limit), 5xx, or a captcha/CDN HTML page through the
// same URL as a real stream. Feeding non-SSE bytes into decodeSSEStream
// silently fails — the decoder finds no event lines, the watchdog fires
// after 120s, and the overlay sits frozen on the previous turn's state.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldTeeAndDecode } from '../../lib/sse-gate';

describe('shouldTeeAndDecode (canonical SSE gate)', () => {
    it('tees a 200 response with text/event-stream + charset', () => {
        expect(shouldTeeAndDecode(200, 'text/event-stream; charset=utf-8', true)).toBe(true);
    });

    it('tees a 200 response with bare text/event-stream', () => {
        expect(shouldTeeAndDecode(200, 'text/event-stream', true)).toBe(true);
    });

    it('matches case-insensitively (HTTP header values are not auto-lowercased)', () => {
        expect(shouldTeeAndDecode(200, 'TEXT/EVENT-STREAM', true)).toBe(true);
        expect(shouldTeeAndDecode(200, 'Text/Event-Stream; charset=UTF-8', true)).toBe(true);
    });

    it('rejects content types that merely contain the substring', () => {
        // Pre-fix the gate used .includes('event-stream'), which would have
        // accepted these. startsWith('text/event-stream') closes that hole.
        expect(shouldTeeAndDecode(200, 'application/x-no-event-stream', true)).toBe(false);
        expect(shouldTeeAndDecode(200, 'application/json+event-stream', true)).toBe(false);
    });

    it('skips tee on a 429 rate-limit response', () => {
        expect(shouldTeeAndDecode(429, 'application/json', true)).toBe(false);
    });

    it('skips tee on a 500 server-error response', () => {
        // Status takes precedence over content-type: even if claude.ai sets
        // text/event-stream on a 500, we should not feed the body to the
        // decoder.
        expect(shouldTeeAndDecode(500, 'text/event-stream', true)).toBe(false);
    });

    it('skips tee on a 200 captcha/CDN HTML response', () => {
        // Cloudflare interstitials and Anthropic's own captcha challenges
        // land on this endpoint with status 200 + text/html. Treating them
        // as SSE is what froze the overlay before this fix.
        expect(shouldTeeAndDecode(200, 'text/html; charset=utf-8', true)).toBe(false);
    });

    it('skips tee on a 200 response with no content-type header', () => {
        expect(shouldTeeAndDecode(200, '', true)).toBe(false);
    });

    it('skips tee when the response body is missing', () => {
        // Defensive: even an SSE-shaped header should not trigger tee if
        // the body is null (some intermediaries strip it; tee() would throw).
        expect(shouldTeeAndDecode(200, 'text/event-stream', false)).toBe(false);
    });
});

describe('inject.ts inline gate stays in sync with lib/sse-gate.ts', () => {
    // Read the inject.ts source as text. If the inline gate drifts from the
    // canonical predicate's fingerprint, these assertions fail and the next
    // committer sees that they need to update both places.
    const injectSource = readFileSync(
        resolve(__dirname, '../../entrypoints/inject.ts'),
        'utf-8',
    );

    it('matches the canonical content-type literal', () => {
        expect(injectSource).toContain("'text/event-stream'");
    });

    it('lowercases the content-type before matching', () => {
        expect(injectSource).toContain('.toLowerCase()');
    });

    it('uses startsWith, not includes, for content-type matching', () => {
        expect(injectSource).toMatch(/startsWith\(['"]text\/event-stream['"]\)/);
    });

    it('checks the gate against status === 200 explicitly', () => {
        expect(injectSource).toMatch(/response\.status === 200/);
    });
});
