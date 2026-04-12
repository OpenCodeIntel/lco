// entrypoints/sidepanel/hooks/useDashboardData.ts
//
// Single data-fetching hook for the side panel dashboard. All chrome.storage reads
// and chrome.tabs queries originate here. Components receive pre-computed state and
// never touch Chrome APIs directly.
//
// Architecture position: this hook is the Memory Agent interface for the dashboard.
// It sits between the React component tree and the agent layer (lib/). Swap this
// implementation and every component stays unchanged.
//
// Tab awareness: the hook tracks whether the active tab is on claude.ai. Live data
// (Usage Budget) is only loaded when isClaudeTab is true. Historical data (Today,
// History) is always visible -- it is org-scoped, not tab-specific.
//
// Callers: entrypoints/sidepanel/App.tsx (sole consumer).

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    getDailySummary,
    computeDailySummary,
    getConversation,
    listConversations,
    getUsageLimits,
    getUsageDeltas,
    todayDateString,
    type DailySummary,
    type ConversationRecord,
} from '../../../lib/conversation-store';
import { computeHealthScore, computeGrowthRate, type HealthScore } from '../../../lib/health-score';
import { computeUsageBudget } from '../../../lib/usage-budget';
import { computeTokenEconomics, type TokenEconomicsResult } from '../../../lib/token-economics';
import type { UsageBudgetResult } from '../../../lib/message-types';

// ── Constants ─────────────────────────────────────────────────────────────────

// Single domain string used by every live-data gate in this file.
// If claude.ai ever moves to a subdomain or new domain, this is the only edit needed.
const CLAUDE_DOMAIN = 'claude.ai';

// Maximum number of past conversations to load into the History panel.
const CONVERSATION_LIMIT = 20;

// ── Tab URL gate ──────────────────────────────────────────────────────────────

/**
 * Returns true if the given URL string belongs to the Claude web app.
 *
 * Uses the URL constructor for exact hostname comparison, not a substring search.
 * A substring check (`url.includes('claude.ai')`) would false-positive on domains
 * like `notclaude.ai` or query strings containing `claude.ai`. Hostname comparison
 * is immune to both.
 *
 * Returns false for any non-parseable string (the URL constructor throws on
 * invalid input, which the caller's try/catch catches).
 */
function isClaudeUrl(url: string): boolean {
    return new URL(url).hostname === CLAUDE_DOMAIN;
}

/**
 * Returns true if the tab identified by tabId is currently showing a claude.ai page.
 *
 * This is the single gate for all live data loading in the dashboard. Call this
 * before loading any data that requires an active Claude session.
 *
 * Returns false if the tab does not exist, if the URL is undefined (e.g. chrome://
 * pages where the extension has no URL access), if the URL is not parseable, or if
 * chrome.tabs.get throws for any reason.
 *
 * @param tabId - Chrome tab ID to check.
 * @returns Promise that resolves to true only when the tab is on claude.ai.
 */
export async function isTabOnClaude(tabId: number): Promise<boolean> {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.url) return false;
        return isClaudeUrl(tab.url);
    } catch {
        // Tab closed, extension lacks URL permission, or URL string is not parseable.
        return false;
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DashboardData {
    today: DailySummary | null;
    activeConv: ConversationRecord | null;
    activeHealth: HealthScore | null;
    conversations: ConversationRecord[];
    budget: UsageBudgetResult | null;
    /**
     * True when the currently active tab is on claude.ai.
     *
     * Gate any data loader that requires an active Claude session on this flag.
     * Historical data (today, conversations) is always valid regardless of its value.
     */
    isClaudeTab: boolean;
    /**
     * Token economics derived from the per-account delta log.
     * Null until enough delta records exist (MIN_SAMPLES per model).
     * Maps model name to median tokens per 1% of session consumed.
     */
    tokenEconomics: TokenEconomicsResult | null;
    loading: boolean;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useDashboardData(): DashboardData {
    const [today, setToday] = useState<DailySummary | null>(null);
    const [activeConv, setActiveConv] = useState<ConversationRecord | null>(null);
    const [activeHealth, setActiveHealth] = useState<HealthScore | null>(null);
    const [conversations, setConversations] = useState<ConversationRecord[]>([]);
    const [budget, setBudget] = useState<UsageBudgetResult | null>(null);
    const [isClaudeTab, setIsClaudeTab] = useState(false);
    const [tokenEconomics, setTokenEconomics] = useState<TokenEconomicsResult | null>(null);
    const [loading, setLoading] = useState(true);

    // Track current tab ID so we know which activeConv_ key to watch.
    const tabIdRef = useRef<number | null>(null);
    // Track current organization ID for account-scoped queries.
    const orgIdRef = useRef<string>('');
    // Ref mirror of isClaudeTab so event listeners (closures) can read the current
    // value without capturing a stale boolean from the render cycle.
    const isClaudeTabRef = useRef(false);

    // Sync helper: always update both the React state and the ref together so
    // they never drift. All code that changes isClaudeTab must use this.
    function applyIsClaudeTab(value: boolean) {
        isClaudeTabRef.current = value;
        setIsClaudeTab(value);
    }

    // ── Data loaders ─────────────────────────────────────────────────────────

    const loadToday = useCallback(async () => {
        try {
            const orgId = orgIdRef.current;
            if (!orgId) return;
            const date = todayDateString();
            // Try the cached summary first; compute on demand if the 30-min alarm
            // has not fired yet today (avoids the "all zeros" cold-start bug).
            const summary = await getDailySummary(orgId, date) ?? await computeDailySummary(orgId, date);
            setToday(summary);
        } catch (err) {
            console.error('[Saar] Failed to load daily summary:', err);
        }
    }, []);

    const loadConversations = useCallback(async () => {
        try {
            const orgId = orgIdRef.current;
            if (!orgId) return;
            const list = await listConversations(orgId, CONVERSATION_LIMIT);
            setConversations(list);
        } catch {
            // Empty state is fine.
        }
    }, []);

    const loadTokenEconomics = useCallback(async () => {
        const orgId = orgIdRef.current;
        if (!orgId) {
            // Org cleared (logout or not yet known): wipe any stale economics
            // from the previous account so no cross-account data leaks through.
            setTokenEconomics(null);
            return;
        }
        try {
            const deltas = await getUsageDeltas(orgId);
            // Stale-check: org may have changed while getUsageDeltas was in flight.
            if (orgIdRef.current !== orgId) return;
            // computeTokenEconomics filters models below MIN_SAMPLES internally.
            // Returns empty Maps when not enough data exists yet.
            setTokenEconomics(computeTokenEconomics(deltas));
        } catch {
            // Non-critical: token economics panel just stays empty.
        }
    }, []);

    const loadActiveConversation = useCallback(async (tabId: number) => {
        try {
            // Read the active conversation and org ID for this tab from session storage.
            const cKey = `activeConv_${tabId}`;
            const oKey = `activeOrg_${tabId}`;
            const result = await chrome.storage.session.get([cKey, oKey]);
            const convId = result[cKey] as string | undefined;
            const orgId = result[oKey] as string | undefined;

            // Treat the session-read orgId as the source of truth.
            // Update the ref immediately (clears to '' on logout) so loadConversations
            // and loadToday always query the correct account scope.
            const prevOrg = orgIdRef.current;
            orgIdRef.current = orgId ?? '';

            // Org changed: includes first-login (prevOrg '' → real org) and account
            // switch or logout. Any transition should reload history and today.
            const orgChanged = prevOrg !== (orgId ?? '');

            if (!convId || !orgId) {
                setActiveConv(null);
                setActiveHealth(null);
                // Org cleared (logout): reset dashboard to empty state.
                if (!orgId && prevOrg) {
                    setToday(null);
                    setConversations([]);
                    setBudget(null);
                    setTokenEconomics(null);
                }
                return;
            }

            const conv = await getConversation(orgId, convId);
            setActiveConv(conv);

            if (conv) {
                const growthRate = computeGrowthRate(conv.turns.map(t => t.contextPct));
                const health = computeHealthScore({
                    contextPct: conv.lastContextPct,
                    turnCount: conv.turnCount,
                    growthRate,
                });
                setActiveHealth(health);
            } else {
                setActiveHealth(null);
            }

            // Account switched: reload history, today, and token economics for the new org.
            if (orgChanged) {
                loadConversations();
                loadToday();
                loadTokenEconomics();
            }
        } catch {
            setActiveConv(null);
            setActiveHealth(null);
        }
    }, [loadConversations, loadToday, loadTokenEconomics]);

    const loadBudget = useCallback(async () => {
        try {
            const orgId = orgIdRef.current;
            if (!orgId) return;
            const limits = await getUsageLimits(orgId);
            // Stale-check: the org may have changed while getUsageLimits was in flight
            // (account switch, logout, tab change). Applying stale data from the old org
            // would overwrite the correct cleared or newly-loaded state. Discard it.
            if (orgIdRef.current !== orgId) return;
            if (!limits) {
                setBudget(null);
                return;
            }
            setBudget(computeUsageBudget(limits, Date.now()));
        } catch {
            // Dashboard shows nothing rather than crash.
        }
    }, []);

    // ── Initial load ──────────────────────────────────────────────────────────

    useEffect(() => {
        async function init() {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            let onClaude = false;
            // typeof check instead of truthy: tabId 0 is falsy but is a valid Chrome tab ID.
            if (typeof tab?.id === 'number') {
                tabIdRef.current = tab.id;
                onClaude = await isTabOnClaude(tab.id);
                applyIsClaudeTab(onClaude);
                await loadActiveConversation(tab.id);
                // Clear stale budget immediately if we opened the panel on a non-Claude tab.
                // Budget is live, session-bound data -- it is meaningless outside claude.ai.
                if (!onClaude) {
                    setBudget(null);
                }
            }

            // loadConversations first: it triggers bulk legacy migration if the
            // account-scoped index is empty. loadToday depends on migrated records.
            // Both are historical (org-scoped) and load regardless of isClaudeTab.
            await loadConversations();
            await loadToday();
            if (onClaude) {
                await loadBudget();
            }
            // Token economics is non-blocking: fire after the main data loads.
            // It requires enough delta records to be meaningful (MIN_SAMPLES per model),
            // so it may return empty Maps on first load.
            loadTokenEconomics();
            setLoading(false);
        }

        init();
    }, [loadToday, loadConversations, loadActiveConversation, loadBudget, loadTokenEconomics]);

    // ── Live subscriptions ────────────────────────────────────────────────────

    useEffect(() => {
        // Re-fetch when storage changes (new turn completed, daily summary recomputed).
        function onStorageChanged(
            changes: Record<string, chrome.storage.StorageChange>,
            area: string,
        ) {
            const keys = Object.keys(changes);

            if (area === 'local') {
                const hasConvChange = keys.some(k => k.startsWith('conv:') || k.startsWith('convIndex'));
                const hasDailyChange = keys.some(k => k.startsWith('daily:'));
                const hasBudgetChange = keys.some(k => k.startsWith('usageLimits:'));
                const hasDeltaChange = keys.some(k => k.startsWith('usageDeltas:'));

                if (hasConvChange) {
                    loadConversations();
                    if (tabIdRef.current !== null) {
                        loadActiveConversation(tabIdRef.current);
                    }
                }
                if (hasDailyChange) {
                    loadToday();
                }
                // Guard: only reload budget when on a Claude tab. A background alarm can
                // write fresh usage limits to storage while the user is on Gmail -- without
                // this check the budget card would silently re-populate on a non-Claude tab.
                if (hasBudgetChange && isClaudeTabRef.current) {
                    loadBudget();
                }
                if (hasDeltaChange) {
                    loadTokenEconomics();
                }
            }

            if (area === 'session') {
                const hasActiveChange = keys.some(
                    k => k.startsWith('activeConv_') || k.startsWith('activeOrg_'),
                );
                if (hasActiveChange && tabIdRef.current !== null) {
                    loadActiveConversation(tabIdRef.current);
                }
            }
        }

        // Tab switch: user clicked a different tab in the same window.
        // Async because we need to check the new tab's URL before deciding what to load.
        async function onTabActivated(info: { tabId: number; windowId: number }) {
            // Record the new tab immediately so any concurrent resolution can detect staleness.
            tabIdRef.current = info.tabId;

            const onClaude = await isTabOnClaude(info.tabId);

            // Stale-check: if the user switched tabs again while this await was in flight,
            // discard this result. The newer activation will apply its own state.
            if (tabIdRef.current !== info.tabId) return;

            applyIsClaudeTab(onClaude);

            // loadActiveConversation updates orgIdRef; budget loading reads orgIdRef.
            // Await it so loadBudget sees the correct org scope.
            await loadActiveConversation(info.tabId);

            if (onClaude) {
                loadBudget();
            } else {
                // Explicitly clear budget -- do not show stale data from the previous
                // Claude tab while the user is on Gmail, GitHub, etc.
                setBudget(null);
            }
        }

        // URL changed within the currently-active tab (e.g. the user navigated from
        // claude.ai to gmail.com without switching tabs). onTabActivated does not fire
        // in this case, so we need this separate listener.
        function onTabUpdated(
            tabId: number,
            changeInfo: chrome.tabs.OnUpdatedInfo,
        ) {
            // Only care about URL changes on the tab the panel is currently tracking.
            if (tabId !== tabIdRef.current) return;
            // changeInfo.url is only present when the URL actually changed.
            if (!changeInfo.url) return;

            // Use isClaudeUrl (hostname comparison) for the same reason as isTabOnClaude:
            // a substring check would false-positive on domains like notclaude.ai.
            const onClaude = isClaudeUrl(changeInfo.url);
            applyIsClaudeTab(onClaude);

            if (onClaude) {
                // Navigated back to claude.ai: reload live data.
                loadBudget();
            } else {
                // Navigated away: clear live data immediately.
                setBudget(null);
            }
        }

        // Tab closed while panel is open.
        function onTabRemoved(removedTabId: number) {
            if (removedTabId !== tabIdRef.current) return;
            setActiveConv(null);
            setActiveHealth(null);
            // The closed tab was on Claude; mark the panel as not-Claude since there
            // is no active tab to track. The user will need to click another tab.
            applyIsClaudeTab(false);
            setBudget(null);
        }

        chrome.storage.onChanged.addListener(onStorageChanged);
        chrome.tabs.onActivated.addListener(onTabActivated);
        chrome.tabs.onUpdated.addListener(onTabUpdated);
        chrome.tabs.onRemoved.addListener(onTabRemoved);

        return () => {
            chrome.storage.onChanged.removeListener(onStorageChanged);
            chrome.tabs.onActivated.removeListener(onTabActivated);
            chrome.tabs.onUpdated.removeListener(onTabUpdated);
            chrome.tabs.onRemoved.removeListener(onTabRemoved);
        };
    }, [loadToday, loadConversations, loadActiveConversation, loadBudget, loadTokenEconomics]);

    return { today, activeConv, activeHealth, conversations, budget, isClaudeTab, tokenEconomics, loading };
}
