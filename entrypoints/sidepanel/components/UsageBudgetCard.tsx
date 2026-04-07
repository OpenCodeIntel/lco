// entrypoints/sidepanel/components/UsageBudgetCard.tsx
// Displays real-time Anthropic usage limits in the side panel dashboard.
//
// Data source: /api/organizations/{orgId}/usage (fetched by content script on
// page load and after each response, stored as usageLimits:{accountId}).
// The numbers here match claude.ai/settings/limits exactly -- no estimation.
//
// Props: UsageBudgetResult from lib/usage-budget.ts (the Usage Budget Agent).
// When budget is null, renders a placeholder prompt to load claude.ai.

import React from 'react';
import type { UsageBudgetResult, BudgetZone } from '../../../lib/message-types';
import { classifyZone } from '../../../lib/usage-budget';

interface Props {
    budget: UsageBudgetResult | null;
}

// Zone-to-label mapping for the dot and fills.
// Mirrors the health dot pattern in ActiveConversation.tsx.
const ZONE_LABELS: Record<BudgetZone, string> = {
    comfortable: 'Comfortable',
    moderate: 'Moderate',
    tight: 'Tight',
    critical: 'Critical',
};

export default function UsageBudgetCard({ budget }: Props) {
    if (!budget) {
        return (
            <div className="lco-dash-budget lco-dash-budget--empty">
                <p className="lco-dash-placeholder">Open claude.ai to load usage data</p>
            </div>
        );
    }

    const { sessionPct, weeklyPct, sessionMinutesUntilReset, weeklyResetLabel, zone, statusLabel } = budget;

    // Clamp to [0, 100] for the bar fill. The API returns 0-100 already, but
    // defensive clamping prevents scaleX values outside [0, 1].
    const safeSessionPct = Math.min(Math.max(sessionPct, 0), 100);
    const safeWeeklyPct = Math.min(Math.max(weeklyPct, 0), 100);

    // Format session reset: "53 min" | "1h 12m" | "now"
    const resetText = formatSessionReset(sessionMinutesUntilReset);

    return (
        <div className="lco-dash-budget">
            {/* Header: zone dot + zone label */}
            <div className="lco-dash-budget-header">
                <span className={`lco-dash-budget-dot lco-dash-budget-dot--${zone}`} />
                <span className="lco-dash-budget-zone-label">{ZONE_LABELS[zone]}</span>
            </div>

            {/* Primary status line */}
            <p className="lco-dash-budget-status">{statusLabel}</p>

            {/* Session bar */}
            <div className="lco-dash-budget-row">
                <span className="lco-dash-budget-row-label">Session</span>
                <div className="lco-dash-budget-bar">
                    <div
                        className={`lco-dash-budget-fill lco-dash-budget-fill--${zone}`}
                        style={{ transform: `scaleX(${safeSessionPct / 100})` }}
                    />
                </div>
                <span className="lco-dash-budget-row-pct">{Math.round(safeSessionPct)}%</span>
            </div>

            {/* Weekly bar uses its own zone based on weeklyPct alone.
                The card header zone (dot + status label) reflects max(sessionPct, weeklyPct)
                so it captures whichever window is more exhausted.
                The weekly bar colors itself independently so each bar reads on its own. */}
            <div className="lco-dash-budget-row">
                <span className="lco-dash-budget-row-label">Weekly</span>
                <div className="lco-dash-budget-bar">
                    <div
                        className={`lco-dash-budget-fill lco-dash-budget-fill--${classifyZone(weeklyPct)}`}
                        style={{ transform: `scaleX(${safeWeeklyPct / 100})` }}
                    />
                </div>
                <span className="lco-dash-budget-row-pct">{Math.round(safeWeeklyPct)}%</span>
            </div>

            {/* Reset times */}
            <div className="lco-dash-budget-resets">
                <span>Session resets in {resetText}</span>
                <span>Weekly resets {weeklyResetLabel}</span>
            </div>
        </div>
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSessionReset(minutes: number): string {
    if (minutes <= 0) return 'now';
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
