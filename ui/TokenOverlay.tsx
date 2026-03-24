// ui/TokenOverlay.tsx — Phase 1 overlay widget (no external UI libraries)

export interface OverlayProps {
    lastRequest: {
        inputTokens: number;
        outputTokens: number;
        model: string;
        cost: number | null;
    } | null;
    session: {
        requestCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCost: number | null;
    };
    messageLimitUtilization: number | null;
    contextPct: number | null;
    healthBroken: string | null;
}

function fmtNum(n: number): string {
    // Fixed locale so separators are consistent regardless of browser language.
    return n.toLocaleString('en-US');
}

function fmtCost(cost: number | null): string {
    if (cost === null) return '';
    if (cost < 0.0005) return ' · ~$0.00*';
    return ` · ~$${cost.toFixed(3)}`;
}

function BlockBar({ pct }: { pct: number }) {
    // Math.floor so the bar only reaches full at exactly 100%, not at 95%.
    const filled = Math.min(Math.floor(pct * 10), 10);
    return <span>{'█'.repeat(filled) + '░'.repeat(10 - filled)}</span>;
}

export default function TokenOverlay({ lastRequest, session, messageLimitUtilization, contextPct, healthBroken }: OverlayProps) {
    if (!lastRequest && messageLimitUtilization === null && session.requestCount === 0 && !healthBroken) {
        return null;
    }

    const totalTokens = session.totalInputTokens + session.totalOutputTokens;
    const pct = messageLimitUtilization ?? 0;

    return (
        <div className="lco-widget">
            {lastRequest && (
                <div className="lco-row">
                    <span className="lco-label">now</span>
                    <span className="lco-value">
                        ~{fmtNum(lastRequest.inputTokens)} in · ~{fmtNum(lastRequest.outputTokens)} out
                        <span className="lco-accent">{fmtCost(lastRequest.cost)}</span>
                    </span>
                </div>
            )}

            {contextPct !== null && contextPct > 0 && (
                <div className="lco-row">
                    <span className="lco-label">ctx</span>
                    <span className="lco-value">{Math.min(contextPct, 100).toFixed(1)}% of window</span>
                </div>
            )}

            {messageLimitUtilization !== null && (
                <>
                    <div className="lco-bar-track">
                        <div className="lco-bar-fill" style={{ width: `${Math.min(pct * 100, 100)}%` }} />
                    </div>
                    <div className="lco-row">
                        <span className="lco-label">
                            <BlockBar pct={pct} /> {(pct * 100).toFixed(0)}% limit used
                        </span>
                    </div>
                </>
            )}

            {session.requestCount > 0 && (
                <>
                    <div className="lco-divider" />
                    <div className="lco-row">
                        <span className="lco-label">session</span>
                        <span className="lco-value">
                            {session.requestCount} req · ~{fmtNum(totalTokens)} tokens
                            <span className="lco-accent">{fmtCost(session.totalCost)}</span>
                        </span>
                    </div>
                </>
            )}

            {healthBroken && (
                <div className="lco-row">
                    <span className="lco-warn">⚠ {healthBroken}</span>
                </div>
            )}
        </div>
    );
}
