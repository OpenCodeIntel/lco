// entrypoints/sidepanel/components/UsageBudgetCard.tsx
// Displays real-time Anthropic usage limits in the side panel dashboard.
//
// Data source: /api/organizations/{orgId}/usage (fetched by content script on
// page load and after each response, stored as usageLimits:{accountId}).
// The numbers here match claude.ai/settings/limits exactly -- no estimation.
//
// Tier dispatch:
//   - session     → original Pro/Personal/Max layout: session bar + weekly bar
//   - credit      → Enterprise: a single monthly spend bar in dollars
//   - unsupported → explicit "we can't read this account type" empty state
//
// Empty states:
//   - !isClaudeTab && !budget → prompt the user to open claude.ai
//   - isClaudeTab but no usable budget → tell them this account isn't supported
//
// Props: typed budget result from lib/usage-budget.ts plus the tab-awareness
// flag from useDashboardData.ts. Components further down receive pre-computed
// state and never touch chrome.* directly.

import React from 'react';
import type { UsageBudgetResult, UsageBudgetSession, UsageBudgetCredit, BudgetZone } from '../../../lib/message-types';
import { classifyZone } from '../../../lib/usage-budget';
import { formatEtaLabel, type WeeklyEta } from '../../../lib/weekly-cap-eta';
import { formatCurrencyCents } from '../../../lib/format';
import type { SpendTrajectory, ConversationSpend } from '../../../lib/spend-trajectory';
import type { ConversationRecord } from '../../../lib/conversation-store';

interface Props {
    budget: UsageBudgetResult | null;
    /**
     * True when the active tab is on claude.ai. Drives the empty-state copy:
     * off-tab users get a prompt to open claude.ai; on-tab users with no usable
     * data get the "account type not supported" message.
     */
    isClaudeTab: boolean;
    /**
     * Weekly-cap ETA from the weekly-cap ETA agent. Null until enough snapshots
     * have accumulated, or when usage is flat/declining, or post-reset.
     * Session tier only; credit/unsupported cards never receive this.
     */
    weeklyEta?: WeeklyEta | null;
    /**
     * Month-end spend projection. Credit-tier only; null on session/unsupported
     * tiers and until at least 7 distinct cost-bearing days have accumulated
     * in the current month.
     */
    spendTrajectory?: SpendTrajectory | null;
    /**
     * Top conversations of the current month, ranked descending by total cost.
     * Credit-tier only; empty array everywhere else.
     */
    topSpendConversations?: ConversationSpend[];
    /**
     * Recent conversations from the History panel. Used to join conversationId
     * from `topSpendConversations` to a human-readable subject without an
     * additional storage read.
     */
    conversations?: ConversationRecord[];
}

// Zone-to-label mapping for the dot and fills. Mirrors the health dot
// pattern in ActiveConversation.tsx. The credit variant replaces the zone
// name with a tier label ("Enterprise") because the four-zone vocabulary
// does not translate cleanly to a single monthly bar.
const ZONE_LABELS: Record<BudgetZone, string> = {
    comfortable: 'Comfortable',
    moderate: 'Moderate',
    tight: 'Tight',
    critical: 'Critical',
};

export default function UsageBudgetCard({
    budget,
    isClaudeTab,
    weeklyEta,
    spendTrajectory,
    topSpendConversations,
    conversations,
}: Props) {
    // No data at all + the user is on a tab where we cannot fetch any.
    // Surface the obvious next action rather than a silent empty card.
    if (!budget && !isClaudeTab) {
        return (
            <div className="lco-dash-budget lco-dash-budget--empty">
                <p className="lco-dash-placeholder">Open claude.ai to load usage data</p>
            </div>
        );
    }

    // We are on claude.ai but the response did not match either tier shape we
    // know about. This is the honest state for Teams accounts (and possibly
    // future tiers): we fetched, parsed, and found nothing actionable. Better
    // than silently rendering empty bars that look like a fresh session.
    if (!budget || budget.kind === 'unsupported') {
        return (
            <div className="lco-dash-budget lco-dash-budget--empty">
                <p className="lco-dash-placeholder">Saar can&apos;t read usage on this account type yet</p>
            </div>
        );
    }

    // Session and credit each get their own render path; the discriminator on
    // `budget.kind` lets TypeScript narrow into the right field set.
    return budget.kind === 'session'
        ? <SessionBudget budget={budget} eta={weeklyEta ?? null} />
        : <CreditBudget
            budget={budget}
            trajectory={spendTrajectory ?? null}
            topSpenders={topSpendConversations ?? []}
            conversations={conversations ?? []}
        />;
}

// ── Session variant (Pro / Personal / Max) ───────────────────────────────────

function SessionBudget({ budget, eta }: { budget: UsageBudgetSession; eta: WeeklyEta | null }) {
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

            {/* ETA projection: shown under the weekly bar when the agent has
                enough history to project confidently. Hidden when null (too few
                snapshots, flat/declining usage, or immediately after a reset). */}
            {eta !== null && (
                <p className="lco-dash-budget-eta">{formatEtaLine(eta)}</p>
            )}

            {/* Reset times */}
            <div className="lco-dash-budget-resets">
                <span>Session resets in {resetText}</span>
                <span>Weekly resets {weeklyResetLabel}</span>
            </div>
        </div>
    );
}

// ── Credit variant (Enterprise) ──────────────────────────────────────────────

function CreditBudget({
    budget,
    trajectory,
    topSpenders,
    conversations,
}: {
    budget: UsageBudgetCredit;
    trajectory: SpendTrajectory | null;
    topSpenders: ConversationSpend[];
    conversations: ConversationRecord[];
}) {
    const { utilizationPct, zone, statusLabel, resetLabel, currency, monthlyLimitCents } = budget;
    const safePct = Math.min(Math.max(utilizationPct, 0), 100);

    return (
        <div className="lco-dash-budget">
            {/* Header: zone dot drives the bar color, but the label is the tier
                name. "Comfortable / Moderate / Tight / Critical" applies to a
                rolling window — for a monthly credit pool, the user just wants
                to know what tier they're on. */}
            <div className="lco-dash-budget-header">
                <span className={`lco-dash-budget-dot lco-dash-budget-dot--${zone}`} />
                <span className="lco-dash-budget-zone-label">Enterprise</span>
            </div>

            {/* Primary status line: "$304.91 of $500.00 spent" */}
            <p className="lco-dash-budget-status">{statusLabel}</p>

            {/* Trajectory line: confidence-tiered projection, or a "need more data"
                placeholder when fewer than 7 cost-bearing days have accumulated this
                month. Hidden in the empty-state when there is nothing to say. */}
            <p className="lco-dash-budget-trajectory">
                {formatTrajectoryLine(trajectory, currency, monthlyLimitCents)}
            </p>

            {/* Single monthly spend bar */}
            <div className="lco-dash-budget-row">
                <span className="lco-dash-budget-row-label">Monthly</span>
                <div className="lco-dash-budget-bar">
                    <div
                        className={`lco-dash-budget-fill lco-dash-budget-fill--${zone}`}
                        style={{ transform: `scaleX(${safePct / 100})` }}
                    />
                </div>
                <span className="lco-dash-budget-row-pct">{Math.round(safePct)}%</span>
            </div>

            {/* Reset line: "Resets May 1" */}
            <div className="lco-dash-budget-resets">
                <span>{resetLabel}</span>
            </div>

            {/* Top spenders: native <details> for native expand/collapse without
                extra state. Hidden when there is nothing to rank yet. */}
            {topSpenders.length > 0 && (
                <details className="lco-dash-budget-spenders">
                    <summary className="lco-dash-budget-spenders-summary">
                        Top conversations this month
                    </summary>
                    <div className="lco-dash-budget-spenders-list">
                        {topSpenders.map((spender) => (
                            <SpenderRow
                                key={spender.conversationId}
                                spender={spender}
                                conversations={conversations}
                                currency={currency}
                            />
                        ))}
                    </div>
                </details>
            )}
        </div>
    );
}

function SpenderRow({
    spender,
    conversations,
    currency,
}: {
    spender: ConversationSpend;
    conversations: ConversationRecord[];
    currency: string;
}) {
    const match = conversations.find((c) => c.id === spender.conversationId);
    const subject = match?.dna?.subject || 'Untitled conversation';
    return (
        <div className="lco-dash-budget-spender">
            <span className="lco-dash-budget-spender-subject">{subject}</span>
            <span className="lco-dash-budget-spender-cost">
                {formatCurrencyCents(spender.totalCostCents, currency)}
            </span>
            <span className="lco-dash-budget-spender-turns">
                {spender.turnCount} turn{spender.turnCount === 1 ? '' : 's'}
            </span>
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

/**
 * Build the one-liner ETA coaching copy for the side-panel card.
 * Copy varies by confidence to calibrate the user's expectation of accuracy.
 */
function formatEtaLine(eta: WeeklyEta): string {
    const label = formatEtaLabel(eta.etaTimestamp);
    switch (eta.confidence) {
        case 'high':
            return `At this pace, you'll hit your weekly cap by ${label}.`;
        case 'medium':
            return `Estimated cap: ${label}. Estimate firms up over the next day.`;
        case 'low':
            return `Estimating: cap by ${label}. Need more data for confidence.`;
    }
}

/**
 * Build the credit-tier trajectory line. Copy varies by confidence to set the
 * user's expectation; a null trajectory becomes the "need more data" placeholder
 * so the layout never collapses while the agent waits for enough samples.
 */
function formatTrajectoryLine(
    trajectory: SpendTrajectory | null,
    currency: string,
    monthlyLimitCents: number,
): string {
    if (!trajectory) {
        return 'Need 7+ days of usage before we can project month-end.';
    }
    const projected = formatCurrencyCents(trajectory.projectedSpentCents, currency);
    const limit = formatCurrencyCents(monthlyLimitCents, currency);
    const monthEnd = formatMonthEndLabel(trajectory.daysRemaining);
    switch (trajectory.confidence) {
        case 'high':
            return `On track for ${projected} of ${limit} by ${monthEnd}.`;
        case 'medium':
            return `Estimated month-end: ${projected} of ${limit}. Estimate firms up over the next week.`;
        case 'low':
            return `Estimating: ${projected} of ${limit} by ${monthEnd}. Need more data for confidence.`;
    }
}

/** "Apr 30" / "May 1": the user-facing label for the projection target. */
function formatMonthEndLabel(daysRemaining: number): string {
    const target = new Date();
    target.setDate(target.getDate() + daysRemaining);
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
    }).format(target);
}
