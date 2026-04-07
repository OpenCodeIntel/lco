// entrypoints/sidepanel/App.tsx
// Top-level dashboard component. Uses useDashboardData for all state.
//
// Section order (top to bottom):
//   Today          - daily token/cost totals
//   Usage Budget   - session and weekly limit percentages with reset countdowns
//   Active Conv    - the conversation in the current tab
//   History        - recent conversation list

import React from 'react';
import { useDashboardData } from './hooks/useDashboardData';
import Header from './components/Header';
import CollapsibleSection from './components/CollapsibleSection';
import TodayCard from './components/TodayCard';
import UsageBudgetCard from './components/UsageBudgetCard';
import ActiveConversation from './components/ActiveConversation';
import ConversationList from './components/ConversationList';

export default function App() {
    const { today, activeConv, activeHealth, conversations, budget, loading } = useDashboardData();

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

            <CollapsibleSection title="Today" storageKey="today" defaultOpen>
                <TodayCard summary={today} />
            </CollapsibleSection>

            <CollapsibleSection title="Usage Budget" storageKey="budget" defaultOpen>
                <UsageBudgetCard budget={budget} />
            </CollapsibleSection>

            <CollapsibleSection title="Active Conversation" storageKey="active" defaultOpen>
                <ActiveConversation conv={activeConv} health={activeHealth} />
            </CollapsibleSection>

            <CollapsibleSection title="History" storageKey="history" defaultOpen>
                <ConversationList conversations={conversations} />
            </CollapsibleSection>
        </div>
    );
}
