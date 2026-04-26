// entrypoints/sidepanel/components/TurnTicker.tsx
// Per-turn cost ticker for the Active Conversation card. Each bar represents
// one turn; height encodes the percentage of the user's session/monthly
// utilization consumed by that turn. The ticker climbs across the row as
// the conversation grows, making context rot literally visible.
//
// Color is intentionally a single accent in this PR. Health-zone coloring
// (patina / brass / ember / rust) is owned by GET-28, which adds the
// per-model threshold logic. Decoupling color from this component lets the
// visualization ship independently of the threshold work.

import React from 'react';
import type { TurnRecord } from '../../../lib/conversation-store';

interface Props {
    turns: TurnRecord[];
    /** How many recent turns to show. The card is narrow, so 12 is roughly
     *  the upper limit before bars collapse below visual threshold. */
    maxBars?: number;
}

export default function TurnTicker({ turns, maxBars = 12 }: Props): React.ReactElement | null {
    // Need at least one delta to draw anything meaningful. Pre-LCO-34 turns
    // have null deltaUtilization and we filter them out: showing a ticker
    // full of zero-height stubs would mislead more than help.
    const tracked = turns.filter(turnHasDelta);
    if (tracked.length === 0) return null;

    const window = tracked.slice(-maxBars);

    // Normalize bar heights to the tallest bar in the visible window. This
    // keeps the visual story relative ("turn 5 was the biggest of the run")
    // rather than absolute, which would compress everything when one outlier
    // dominates. The 6% floor ensures every bar is visible, including the
    // smallest non-zero turn.
    const peak = Math.max(...window.map(t => t.deltaUtilization ?? 0), 0.01);
    const last = window[window.length - 1];
    const prev = window.length >= 2 ? window[window.length - 2] : null;
    const trend = computeTrend(prev?.deltaUtilization ?? null, last.deltaUtilization ?? null);

    return (
        <div
            className="lco-ticker"
            role="img"
            aria-label={describeTicker(window)}
        >
            <div className="lco-ticker-bars">
                {window.map((turn) => {
                    const value = turn.deltaUtilization ?? 0;
                    const heightPct = peak > 0 ? Math.max((value / peak) * 100, 6) : 6;
                    return (
                        <span
                            key={turn.turnNumber}
                            className="lco-ticker-bar"
                            style={{ height: `${heightPct}%` }}
                            tabIndex={0}
                            aria-label={`Turn ${turn.turnNumber}: ${value.toFixed(2)}% of session`}
                        />
                    );
                })}
            </div>
            {trend !== null && (
                <span className={`lco-ticker-trend lco-ticker-trend--${trend.direction}`}>
                    {trend.direction === 'up' ? '↑' : '↓'} {Math.abs(trend.percent).toFixed(0)}%
                </span>
            )}
        </div>
    );
}

/** Discriminator: keeps TypeScript happy when narrowing nullable deltas. */
function turnHasDelta(turn: TurnRecord): turn is TurnRecord & { deltaUtilization: number } {
    return typeof turn.deltaUtilization === 'number' && turn.deltaUtilization > 0;
}

/**
 * Relative change between the last two turns. We report percent of previous
 * (so 0.05% -> 0.10% reads as +100%) rather than absolute delta because the
 * absolute number for a single turn is too small to communicate growth.
 * Suppressed when the previous turn was zero or missing.
 */
function computeTrend(previous: number | null, current: number | null): { direction: 'up' | 'down'; percent: number } | null {
    if (previous === null || current === null || previous <= 0) return null;
    const change = ((current - previous) / previous) * 100;
    if (Math.abs(change) < 1) return null;       // tiny moves read as noise
    return { direction: change >= 0 ? 'up' : 'down', percent: change };
}

/** Screen-reader summary of the ticker. The bars themselves are individually
 *  labeled and tabbable, but the container needs a one-shot summary too. */
function describeTicker(turns: TurnRecord[]): string {
    const last = turns[turns.length - 1].deltaUtilization ?? 0;
    return `${turns.length} recent turns, last turn ${last.toFixed(2)} percent of session`;
}
