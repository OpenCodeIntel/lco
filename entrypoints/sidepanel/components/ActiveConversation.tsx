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

    // Fade transition when conversation changes.
    useEffect(() => {
        if (conv?.id !== prevConvId.current) {
            setVisible(false);
            const timer = setTimeout(() => {
                prevConvId.current = conv?.id ?? null;
                setVisible(true);
            }, 150);
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
    const contextPct = conv.lastContextPct;
    const healthLevel = health?.level ?? 'healthy';
    const healthLabel = health?.label ?? 'Healthy';

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
                        style={{ width: `${Math.min(contextPct, 100)}%` }}
                    />
                </div>
                <span className="lco-dash-context-label">{Math.round(contextPct)}% context</span>
            </div>

            <div className="lco-dash-active-stats">
                <span>{conv.turnCount} turn{conv.turnCount === 1 ? '' : 's'}</span>
                <span>{formatTokens(conv.totalInputTokens + conv.totalOutputTokens)} tokens</span>
                <span>{formatCost(conv.estimatedCost)}</span>
            </div>
        </div>
    );
}
