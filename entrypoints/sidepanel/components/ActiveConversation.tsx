// entrypoints/sidepanel/components/ActiveConversation.tsx
// Shows the conversation happening in the current tab.
// Fades gracefully on conversation switch.

import React, { useState, useEffect, useRef } from 'react';
import type { ConversationRecord } from '../../../lib/conversation-store';
import type { HealthScore } from '../../../lib/health-score';
import { formatTokens, formatCost } from '../../../lib/format';

interface Props {
    conv: ConversationRecord | null;
    health: HealthScore | null;
}

export default function ActiveConversation({ conv, health }: Props) {
    const [visible, setVisible] = useState(false);
    const prevConvId = useRef<string | null>(null);

    // Graceful swap: fade + scale out the old card, then pop in the new one.
    // The 250ms delay matches the CSS opacity exit duration so the new content
    // only appears after the old card has fully disappeared. transform + opacity
    // are GPU-composited; no layout or paint for silky 60/120fps.
    // When reduced motion is preferred, skip the delay entirely.
    useEffect(() => {
        if (conv?.id !== prevConvId.current) {
            const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reducedMotion) {
                prevConvId.current = conv?.id ?? null;
                setVisible(true);
                return;
            }
            setVisible(false);
            const timer = setTimeout(() => {
                prevConvId.current = conv?.id ?? null;
                setVisible(true);
            }, 250);
            return () => clearTimeout(timer);
        }
        setVisible(true);
    }, [conv?.id]);

    if (!conv) {
        return (
            <div className="lco-dash-active lco-dash-active--empty">
                <p className="lco-dash-placeholder">No active conversation</p>
            </div>
        );
    }

    const subject = conv.dna?.subject || 'New conversation';
    const rawPct = conv.lastContextPct;
    const safePct = Number.isFinite(rawPct) ? Math.min(Math.max(rawPct, 0), 100) : 0;
    const healthLevel = health?.level ?? 'healthy';
    const healthLabel = health?.label ?? 'Healthy';

    // Total exact session % consumed by all turns in this conversation.
    // Only turns with a valid delta contribute; pre-LCO-34 turns contribute 0.
    const totalDelta = conv.turns.reduce((sum, t) => sum + (t.deltaUtilization ?? 0), 0);
    const showDelta = totalDelta > 0.01;

    return (
        <div className={`lco-dash-active ${visible ? 'lco-dash-active--visible' : 'lco-dash-active--hidden'}`}>
            <div className="lco-dash-active-header">
                <span className={`lco-dash-health-dot lco-dash-health-dot--${healthLevel}`} />
                <span className="lco-dash-health-label">{healthLabel}</span>
            </div>

            <p className="lco-dash-active-subject">{subject}</p>

            <div className="lco-dash-context-bar-container">
                <div className="lco-dash-context-bar">
                    <div
                        className={`lco-dash-context-fill lco-dash-context-fill--${healthLevel}`}
                        style={{ transform: `scaleX(${safePct / 100})` }}
                    />
                </div>
                <span className="lco-dash-context-label">{Math.round(safePct)}% context</span>
            </div>

            <div className="lco-dash-active-stats">
                <span>{conv.turnCount} turn{conv.turnCount === 1 ? '' : 's'}</span>
                <span>{formatTokens(conv.totalInputTokens + conv.totalOutputTokens)} tokens</span>
                {showDelta
                    ? <span>{totalDelta.toFixed(1)}% of session</span>
                    : <span>{formatCost(conv.estimatedCost)}</span>
                }
            </div>
        </div>
    );
}
