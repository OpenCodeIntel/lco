// entrypoints/sidepanel/App.tsx
//
// Root component for the Saar side panel dashboard.
//
// Layout (top to bottom):
//   Header             -- logo, title, subtitle
//   Today              -- daily token and cost totals (always visible)
//   [not-Claude banner] -- shown only when active tab is not claude.ai
//   Usage Budget       -- session and weekly limit bars (live; gated on isClaudeTab)
//   Active Conversation -- the conversation in the current tab
//   History            -- recent conversation list (always visible)
//
// Tab awareness: the Usage Budget section is live data tied to an active Claude
// session. When the user switches to a non-Claude tab, a subtle banner replaces
// the budget data to explain why the section is empty. Today and History are
// org-scoped historical data and remain visible at all times.

import React from 'react';
import { useDashboardData } from './hooks/useDashboardData';
import Header from './components/Header';
import CollapsibleSection from './components/CollapsibleSection';
import TodayCard from './components/TodayCard';
import UsageBudgetCard from './components/UsageBudgetCard';
import ActiveConversation from './components/ActiveConversation';
import ConversationList from './components/ConversationList';
import FeedbackWidget from './components/FeedbackWidget';

export default function App() {
    const {
        today,
        activeConv,
        activeHealth,
        conversations,
        budget,
        isClaudeTab,
        loading,
    } = useDashboardData();

    if (loading) {
        return (
            <div className="lco-dash">
                <Header />
                <div className="lco-dash-loading">Loading...</div>
            </div>
        );
    }

    return (
        <div className="lco-dash">
            <Header />

            {/* Today: historical, always visible regardless of active tab */}
            <CollapsibleSection title="Today" storageKey="today" defaultOpen>
                <TodayCard summary={today} />
            </CollapsibleSection>

            {/* Non-Claude tab banner: explains why Usage Budget is empty.
                Shown only when the active tab is not on claude.ai.
                Today and History remain fully usable below this banner. */}
            {!isClaudeTab && (
                <p className="lco-dash-not-claude-banner">
                    Open a Claude conversation to see live usage data
                </p>
            )}

            {/* Usage Budget: live session data. budget is null when !isClaudeTab
                (cleared by useDashboardData); UsageBudgetCard branches on the
                tier variant (session/credit/unsupported) and chooses the
                empty-state copy from `isClaudeTab`. */}
            <CollapsibleSection title="Usage Budget" storageKey="budget" defaultOpen>
                <UsageBudgetCard budget={budget} isClaudeTab={isClaudeTab} />
            </CollapsibleSection>

            <CollapsibleSection title="Active Conversation" storageKey="active" defaultOpen>
                <ActiveConversation conv={activeConv} health={activeHealth} />
            </CollapsibleSection>

            {/* History: org-scoped, always visible regardless of active tab */}
            <CollapsibleSection title="History" storageKey="history" defaultOpen>
                <ConversationList conversations={conversations} />
            </CollapsibleSection>

            <FeedbackWidget />
        </div>
    );
}
