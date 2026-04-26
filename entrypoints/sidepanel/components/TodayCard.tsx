// entrypoints/sidepanel/components/TodayCard.tsx
// Today's aggregate stats as a single dense row matching overlay typography.
// Cost is rendered tier-aware: Enterprise (credit) accounts see the plain
// dollar amount because they pay per token; Pro/Max/Free see "≈$X API rate"
// since their plan is flat-rate and the figure is informational.

import React from 'react';
import type { DailySummary } from '../../../lib/conversation-store';
import type { UsageBudgetResult } from '../../../lib/message-types';
import { formatTokens, formatApiRateCost } from '../../../lib/format';

interface Props {
    summary: DailySummary | null;
    /** Active tier; drives whether the cost is rendered as a real charge
     *  (credit) or labeled approximate (session / unsupported / null). */
    budget: UsageBudgetResult | null;
}

export default function TodayCard({ summary, budget }: Props) {
    const conversations = summary?.conversationCount ?? 0;
    const turns = summary?.totalTurns ?? 0;
    const tokens = (summary?.totalInputTokens ?? 0) + (summary?.totalOutputTokens ?? 0);
    const cost = summary?.estimatedCost ?? 0;
    const isEmpty = !summary;

    // The parent <CollapsibleSection title="Today"> already labels this row,
    // so the card itself just renders the stats. Adding a second "today"
    // label inside would stack the word twice in the panel.
    return (
        <div className={`lco-dash-today ${isEmpty ? 'lco-dash-today--empty' : ''}`}>
            <span className="lco-dash-today-stats">
                {conversations} conv · {turns} turn{turns !== 1 ? 's' : ''} · {formatTokens(tokens)} tok · {formatApiRateCost(cost, budget)}
            </span>
        </div>
    );
}
