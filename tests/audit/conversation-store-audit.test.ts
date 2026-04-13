import { describe, test, expect } from 'vitest';

// Audit: lib/conversation-store.ts - pure utility functions only (no storage)

import {
    extractOrganizationId,
    extractConversationId,
    todayDateString,
    isoWeekId,
    extractTopicHint,
    MAX_HINT_CHARS,
} from '../../lib/conversation-store';

// ── extractOrganizationId ──────────────────────────────────────────────────

describe('extractOrganizationId', () => {
    test('extracts from API URL', () => {
        const url = 'https://claude.ai/api/organizations/abc-123-def/usage';
        expect(extractOrganizationId(url)).toBe('abc-123-def');
    });

    test('returns null for URL without organizations', () => {
        expect(extractOrganizationId('https://claude.ai/chat/123')).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(extractOrganizationId('')).toBeNull();
    });

    test('lowercases the result', () => {
        const url = 'https://claude.ai/api/organizations/ABC-123-DEF/usage';
        expect(extractOrganizationId(url)).toBe('abc-123-def');
    });
});

// ── extractConversationId ──────────────────────────────────────────────────

describe('extractConversationId', () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';

    test('extracts from /chat/ URL', () => {
        expect(extractConversationId(`https://claude.ai/chat/${uuid}`)).toBe(uuid);
    });

    test('extracts from /chat_conversations/ URL', () => {
        expect(extractConversationId(`https://claude.ai/api/chat_conversations/${uuid}/completion`)).toBe(uuid);
    });

    test('returns null for URL without conversation UUID', () => {
        expect(extractConversationId('https://claude.ai/settings')).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(extractConversationId('')).toBeNull();
    });

    test('returns null for invalid UUID format', () => {
        expect(extractConversationId('https://claude.ai/chat/not-a-uuid')).toBeNull();
    });

    test('lowercases UUID', () => {
        const upper = '12345678-1234-1234-1234-123456789ABC';
        expect(extractConversationId(`https://claude.ai/chat/${upper}`)).toBe(uuid);
    });
});

// ── todayDateString ────────────────────────────────────────────────────────

describe('todayDateString', () => {
    test('returns YYYY-MM-DD format', () => {
        const result = todayDateString(new Date('2026-04-13T12:00:00').getTime());
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(result).toBe('2026-04-13');
    });

    test('pads single-digit months and days', () => {
        const result = todayDateString(new Date('2026-01-05T12:00:00').getTime());
        expect(result).toBe('2026-01-05');
    });
});

// ── isoWeekId ──────────────────────────────────────────────────────────────

describe('isoWeekId', () => {
    test('returns YYYY-WNN format', () => {
        const result = isoWeekId(new Date('2026-04-13T12:00:00Z').getTime());
        expect(result).toMatch(/^\d{4}-W\d{2}$/);
    });

    test('week number is padded', () => {
        // January 5, 2026 is in week 2
        const result = isoWeekId(new Date('2026-01-05T12:00:00Z').getTime());
        expect(result).toMatch(/-W0[1-9]$/);
    });
});

// ── extractTopicHint ───────────────────────────────────────────────────────

describe('extractTopicHint', () => {
    test('returns empty string for empty input', () => {
        expect(extractTopicHint('')).toBe('');
    });

    test('skips greetings', () => {
        const result = extractTopicHint('Hey\nCan you help me debug this function?');
        expect(result).toBe('Can you help me debug this function?');
    });

    test('skips lines shorter than 10 chars', () => {
        const result = extractTopicHint('ok\nhi\nCan you help me debug this function?');
        expect(result).toBe('Can you help me debug this function?');
    });

    test('skips code blocks', () => {
        const result = extractTopicHint('```\nfunction foo() {}\n```\nPlease review this code for bugs');
        expect(result).toBe('Please review this code for bugs');
    });

    test('truncates at MAX_HINT_CHARS', () => {
        const longLine = 'x'.repeat(150);
        const result = extractTopicHint(longLine);
        expect(result.length).toBe(MAX_HINT_CHARS + 3); // "..." suffix
        expect(result.endsWith('...')).toBe(true);
    });

    test('returns first non-empty line as fallback', () => {
        const result = extractTopicHint('hi\nok\nsure');
        // All lines fail the >= 10 char filter, fallback returns first non-empty
        expect(result).toBe('hi');
    });

    test('greeting detection uses word boundary', () => {
        // "Historical" starts with "hi" but should NOT match the greeting filter
        const result = extractTopicHint('Historical context for the project');
        expect(result).toBe('Historical context for the project');
    });

    test('"no" does not match "Now..."', () => {
        const result = extractTopicHint('Now let me explain the approach');
        expect(result).toBe('Now let me explain the approach');
    });

    test('handles only code block lines', () => {
        const result = extractTopicHint('```\ncode here\n```');
        // Fallback: first non-empty non-code-fence line
        expect(result).toBe('code here');
    });
});
