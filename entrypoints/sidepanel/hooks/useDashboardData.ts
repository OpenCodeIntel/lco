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
    todayDateString,
    type DailySummary,
    type ConversationRecord,
} from '../../../lib/conversation-store';
import { computeHealthScore, computeGrowthRate, type HealthScore } from '../../../lib/health-score';

export interface DashboardData {
    today: DailySummary | null;
    activeConv: ConversationRecord | null;
    activeHealth: HealthScore | null;
    conversations: ConversationRecord[];
    loading: boolean;
}

const CONVERSATION_LIMIT = 20;

export function useDashboardData(): DashboardData {
    const [today, setToday] = useState<DailySummary | null>(null);
    const [activeConv, setActiveConv] = useState<ConversationRecord | null>(null);
    const [activeHealth, setActiveHealth] = useState<HealthScore | null>(null);
    const [conversations, setConversations] = useState<ConversationRecord[]>([]);
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
            const convKey = `activeConv_${tabId}`;
            const orgKey = `activeOrg_${tabId}`;
            const result = await chrome.storage.session.get([convKey, orgKey]);
            const convId = result[convKey] as string | undefined;
            const orgId = result[orgKey] as string | undefined;

            // Update the org ID ref so other loaders use the correct account scope.
            if (orgId) orgIdRef.current = orgId;

            if (!convId || !orgIdRef.current) {
                setActiveConv(null);
                setActiveHealth(null);
                return;
            }

            const conv = await getConversation(orgIdRef.current, convId);
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
        } catch {
            setActiveConv(null);
            setActiveHealth(null);
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

            await Promise.all([loadToday(), loadConversations()]);
            setLoading(false);
        }

        init();
    }, [loadToday, loadConversations, loadActiveConversation]);

    // ── Live subscriptions ───────────────────────────────────────────────────

    useEffect(() => {
        // Re-fetch when storage changes (new turn completed, daily summary recomputed).
        function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
            const keys = Object.keys(changes);

            if (area === 'local') {
                // A conversation record or daily summary changed.
                const hasConvChange = keys.some(k => k.startsWith('conv:') || k === 'convIndex');
                const hasDailyChange = keys.some(k => k.startsWith('daily:'));

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
            }

            if (area === 'session') {
                // Active conversation for a tab changed (SPA navigation to new chat).
                const hasActiveConvChange = keys.some(k => k.startsWith('activeConv_'));
                if (hasActiveConvChange && tabIdRef.current !== null) {
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
    }, [loadToday, loadConversations, loadActiveConversation]);

    return { today, activeConv, activeHealth, conversations, loading };
}
