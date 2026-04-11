// tests/unit/tab-awareness.test.ts
//
// Unit tests for the isTabOnClaude() URL gate exported from useDashboardData.ts.
//
// isTabOnClaude() is the single gate all live-data loaders in the side panel hook
// must call before fetching session-bound data (Usage Budget, pre-submit estimates,
// delta tracking, etc.). These tests verify every URL and error scenario it handles.
//
// Chrome API surface under test:
//   chrome.tabs.get(tabId) -> Tab -- returns a Tab object with a .url property.
//
// Test matrix:
//   - claude.ai URL (full page path)        -> true
//   - claude.ai URL (bare domain)           -> true
//   - non-Claude URL (gmail.com)            -> false
//   - non-Claude URL (github.com)           -> false
//   - notclaude.ai (substring trap)         -> false  (would be true with includes())
//   - subdomain of claude.ai                -> false  (exact hostname match only)
//   - URL containing claude.ai in path      -> false  (hostname is not claude.ai)
//   - chrome:// URL (undefined in MV3)      -> false
//   - tab.url is undefined                  -> false
//   - chrome.tabs.get throws                -> false (tab closed or no permission)
//   - tabId 0 edge case                     -> delegates to chrome.tabs.get normally

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTabOnClaude } from '../../entrypoints/sidepanel/hooks/useDashboardData';

// ── Chrome API mock ────────────────────────────────────────────────────────────

// Minimal chrome.tabs.get mock. Each test overrides mockTabsGet to control the
// resolved tab or force a throw.
const mockTabsGet = vi.fn();

vi.stubGlobal('chrome', {
    tabs: {
        get: mockTabsGet,
    },
});

beforeEach(() => {
    mockTabsGet.mockReset();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockTab(url: string | undefined): chrome.tabs.Tab {
    return { id: 1, index: 0, pinned: false, highlighted: false, windowId: 1,
             active: true, incognito: false, selected: false, discarded: false,
             autoDiscardable: true, groupId: -1, url } as chrome.tabs.Tab;
}

// ── Claude.ai URLs ─────────────────────────────────────────────────────────────

describe('isTabOnClaude -- claude.ai URLs return true', () => {
    it('returns true for a full claude.ai conversation URL', async () => {
        mockTabsGet.mockResolvedValueOnce(
            mockTab('https://claude.ai/chat/abc123'),
        );
        expect(await isTabOnClaude(1)).toBe(true);
    });

    it('returns true for the claude.ai new chat URL', async () => {
        mockTabsGet.mockResolvedValueOnce(
            mockTab('https://claude.ai/new'),
        );
        expect(await isTabOnClaude(1)).toBe(true);
    });

    it('returns true for the bare claude.ai domain', async () => {
        mockTabsGet.mockResolvedValueOnce(
            mockTab('https://claude.ai/'),
        );
        expect(await isTabOnClaude(1)).toBe(true);
    });

    it('returns true for a claude.ai projects URL', async () => {
        mockTabsGet.mockResolvedValueOnce(
            mockTab('https://claude.ai/projects/xyz'),
        );
        expect(await isTabOnClaude(1)).toBe(true);
    });
});

// ── Non-Claude URLs ────────────────────────────────────────────────────────────

describe('isTabOnClaude -- non-Claude URLs return false', () => {
    it('returns false for gmail.com', async () => {
        mockTabsGet.mockResolvedValueOnce(
            mockTab('https://mail.google.com/mail/u/0/'),
        );
        expect(await isTabOnClaude(1)).toBe(false);
    });

    it('returns false for github.com', async () => {
        mockTabsGet.mockResolvedValueOnce(
            mockTab('https://github.com/OpenCodeIntel/lco'),
        );
        expect(await isTabOnClaude(1)).toBe(false);
    });

    it('returns false for notclaude.ai (the includes() substring trap)', async () => {
        // notclaude.ai contains the substring "claude.ai", so a naive includes()
        // check would return true. Hostname comparison returns false correctly.
        mockTabsGet.mockResolvedValueOnce(
            mockTab('https://notclaude.ai/'),
        );
        expect(await isTabOnClaude(1)).toBe(false);
    });

    it('returns false for a subdomain of claude.ai (exact hostname match only)', async () => {
        // api.claude.ai is not a user-navigable page. Only the root claude.ai
        // domain hosts the web UI. Subdomains are excluded by design.
        mockTabsGet.mockResolvedValueOnce(
            mockTab('https://api.claude.ai/path'),
        );
        expect(await isTabOnClaude(1)).toBe(false);
    });

    it('returns false for a URL with claude.ai only in the path, not the hostname', async () => {
        // Ensures we are matching the hostname, not any part of the URL string.
        mockTabsGet.mockResolvedValueOnce(
            mockTab('https://example.com/redirect?to=https://claude.ai'),
        );
        expect(await isTabOnClaude(1)).toBe(false);
    });

    it('returns false for a localhost dev server', async () => {
        mockTabsGet.mockResolvedValueOnce(
            mockTab('http://localhost:3000'),
        );
        expect(await isTabOnClaude(1)).toBe(false);
    });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('isTabOnClaude -- edge cases', () => {
    it('returns false when tab.url is undefined (e.g. chrome:// pages in MV3)', async () => {
        // Chrome does not expose tab.url for chrome:// URLs to extensions.
        mockTabsGet.mockResolvedValueOnce(mockTab(undefined));
        expect(await isTabOnClaude(1)).toBe(false);
    });

    it('returns false when chrome.tabs.get throws (tab was closed mid-flight)', async () => {
        mockTabsGet.mockRejectedValueOnce(new Error('No tab with id: 99'));
        expect(await isTabOnClaude(99)).toBe(false);
    });

    it('returns false when chrome.tabs.get rejects with a non-Error value', async () => {
        // Some Chrome API failures reject with strings rather than Error objects.
        mockTabsGet.mockRejectedValueOnce('Tab not found');
        expect(await isTabOnClaude(5)).toBe(false);
    });

    it('calls chrome.tabs.get with the exact tabId passed in', async () => {
        mockTabsGet.mockResolvedValueOnce(mockTab('https://claude.ai/'));
        await isTabOnClaude(42);
        expect(mockTabsGet).toHaveBeenCalledWith(42);
    });

    it('handles tabId 0 without special-casing it', async () => {
        // tabId 0 is technically valid in Chrome (though unusual).
        mockTabsGet.mockResolvedValueOnce(mockTab('https://claude.ai/'));
        expect(await isTabOnClaude(0)).toBe(true);
    });
});
