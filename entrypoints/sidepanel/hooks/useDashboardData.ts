// entrypoints/sidepanel/hooks/useDashboardData.ts
// Single data-fetching hook for the dashboard. All chrome.storage reads happen here.
// In the multi-agent future, this hook becomes the Memory Agent interface:
// swap the implementation, keep every component unchanged.

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    getDailySummary,
    computeDailySummary,
    getConversation,
    listConversations,
    getUsageLimits,
    todayDateString,
    type DailySummary,
    type ConversationRecord,
} from '../../../lib/conversation-store';
import { computeHealthScore, computeGrowthRate, type HealthScore } from '../../../lib/health-score';
import { computeUsageBudget } from '../../../lib/usage-budget';
import type { UsageBudgetResult } from '../../../lib/message-types';

export interface DashboardData {
    today: DailySummary | null;
    activeConv: ConversationRecord | null;
    activeHealth: HealthScore | null;
    conversations: ConversationRecord[];
    budget: UsageBudgetResult | null;
    loading: boolean;
}

const CONVERSATION_LIMIT = 20;

export function useDashboardData(): DashboardData {
    const [today, setToday] = useState<DailySummary | null>(null);
    const [activeConv, setActiveConv] = useState<ConversationRecord | null>(null);
    const [activeHealth, setActiveHealth] = useState<HealthScore | null>(null);
    const [conversations, setConversations] = useState<ConversationRecord[]>([]);
    const [budget, setBudget] = useState<UsageBudgetResult | null>(null);
    const [loading, setLoading] = useState(true);

    // Track the current tab ID so we know which activeConv_ key to watch.
    const tabIdRef = useRef<number | null>(null);
    // Track the current organization ID for account-scoped queries.
    const orgIdRef = useRef<string>('');

    // ── Data loading ─────────────────────────────────────────────────────────

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

            // Account switched: reload history and today for the new org.
            if (orgChanged) {
                loadConversations();
                loadToday();
            }
        } catch {
            setActiveConv(null);
            setActiveHealth(null);
        }
    }, [loadConversations, loadToday]);

    const loadBudget = useCallback(async () => {
        try {
            const orgId = orgIdRef.current;
            if (!orgId) return;
            const limits = await getUsageLimits(orgId);
            if (!limits) {
                setBudget(null);
                return;
            }
            setBudget(computeUsageBudget(limits, Date.now()));
        } catch {
            // Dashboard shows nothing rather than crash.
        }
    }, []);

    // ── Initial load ─────────────────────────────────────────────────────────

    useEffect(() => {
        async function init() {
            // Find the active tab in the current window.
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
                tabIdRef.current = tab.id;
                await loadActiveConversation(tab.id);
            }

            // loadConversations first: it triggers bulk legacy migration if
            // the account-scoped index is empty. loadToday depends on migrated
            // conversation records to compute the daily summary correctly.
            await loadConversations();
            await loadToday();
            await loadBudget();
            setLoading(false);
        }

        init();
    }, [loadToday, loadConversations, loadActiveConversation, loadBudget]);

    // ── Live subscriptions ───────────────────────────────────────────────────

    useEffect(() => {
        // Re-fetch when storage changes (new turn completed, daily summary recomputed).
        function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
            const keys = Object.keys(changes);

            if (area === 'local') {
                // A conversation record or daily summary changed.
                const hasConvChange = keys.some(k => k.startsWith('conv:') || k.startsWith('convIndex'));
                const hasDailyChange = keys.some(k => k.startsWith('daily:'));
                const hasBudgetChange = keys.some(k => k.startsWith('usageLimits:'));

                if (hasConvChange) {
                    loadConversations();
                    // Also refresh active conv if it was the one that changed.
                    if (tabIdRef.current !== null) {
                        loadActiveConversation(tabIdRef.current);
                    }
                }
                if (hasDailyChange) {
                    loadToday();
                }
                if (hasBudgetChange) {
                    loadBudget();
                }
            }

            if (area === 'session') {
                // Active conversation or org for a tab changed (navigation, logout, account switch).
                const hasActiveChange = keys.some(k => k.startsWith('activeConv_') || k.startsWith('activeOrg_'));
                if (hasActiveChange && tabIdRef.current !== null) {
                    loadActiveConversation(tabIdRef.current);
                }
            }
        }

        // Tab switch: user clicked a different tab in the same window.
        function onTabActivated(info: { tabId: number; windowId: number }) {
            tabIdRef.current = info.tabId;
            loadActiveConversation(info.tabId);
        }

        // Tab closed while panel is open.
        function onTabRemoved(removedTabId: number) {
            if (removedTabId === tabIdRef.current) {
                setActiveConv(null);
                setActiveHealth(null);
            }
        }

        chrome.storage.onChanged.addListener(onStorageChanged);
        chrome.tabs.onActivated.addListener(onTabActivated);
        chrome.tabs.onRemoved.addListener(onTabRemoved);

        return () => {
            chrome.storage.onChanged.removeListener(onStorageChanged);
            chrome.tabs.onActivated.removeListener(onTabActivated);
            chrome.tabs.onRemoved.removeListener(onTabRemoved);
        };
    }, [loadToday, loadConversations, loadActiveConversation, loadBudget]);

    return { today, activeConv, activeHealth, conversations, budget, loading };
}
