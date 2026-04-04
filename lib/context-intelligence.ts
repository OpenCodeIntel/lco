// lib/context-intelligence.ts
// Pure context analysis: no DOM refs, no chrome APIs, no side effects.
// Analyzes ConversationState and returns ContextSignal[] for the nudge system.

// Threshold constants — never use magic numbers in callers.
export const CONTEXT_THRESHOLD_INFO     = 60;  // % at which responses start losing early details
export const CONTEXT_THRESHOLD_WARNING  = 75;  // % at which a new conversation is advisable
export const CONTEXT_THRESHOLD_CRITICAL = 90;  // % at which degradation is near-certain
export const GROWTH_RATE_WARN_PCT       = 10;  // avg % growth per turn that triggers growth warning
export const STALE_MIN_TURNS            = 15;  // turns beyond which long-conversation hint fires
export const STALE_MIN_CONTEXT_PCT      = 50;  // context % that must also be exceeded for stale hint
export const PROJECT_HINT_MIN_TURNS     = 8;   // turns beyond which project hint may fire
export const PROJECT_HINT_MIN_CONTEXT_PCT = 20; // min context % for project hint to be relevant

export interface ConversationState {
    turnCount: number;
    contextPct: number;        // 0-100
    contextHistory: number[];  // contextPct recorded at the end of each turn, oldest first
    model: string;
    contextWindow: number;     // token count, e.g. 200000 for all current Claude models
}

export interface ContextSignal {
    type: 'threshold' | 'growth_warning' | 'stale_conversation' | 'project_hint'
        | 'model_suggestion' | 'large_paste' | 'follow_up_chain';
    severity: 'info' | 'warning' | 'critical';
    message: string;
    dismissible: boolean;
}

// Stable key for tracking dismissed signals. Export so callers can populate the dismissed Set.
export function signalKey(signal: ContextSignal): string {
    return `${signal.type}:${signal.severity}`;
}

// Average upward growth per turn across contextHistory.
// Returns null if there is not enough data or no upward movement.
function computeAverageGrowth(contextHistory: number[]): number | null {
    if (contextHistory.length < 2) return null;
    let totalGrowth = 0;
    let growthCount = 0;
    for (let i = 1; i < contextHistory.length; i++) {
        const delta = contextHistory[i] - contextHistory[i - 1];
        if (delta > 0) {
            totalGrowth += delta;
            growthCount++;
        }
    }
    if (growthCount === 0) return null;
    return totalGrowth / growthCount;
}

// Analyze current conversation state and return all active signals.
// Callers filter out dismissed signals via shouldDismiss().
export function analyzeContext(state: ConversationState): ContextSignal[] {
    const signals: ContextSignal[] = [];
    const { contextPct, turnCount, contextHistory } = state;

    // 1. Threshold alerts — only the highest applicable severity fires.
    if (contextPct >= CONTEXT_THRESHOLD_CRITICAL) {
        signals.push({
            type: 'threshold',
            severity: 'critical',
            message: 'Context is nearly full. Start a new chat to avoid degraded responses.',
            dismissible: false,
        });
    } else if (contextPct >= CONTEXT_THRESHOLD_WARNING) {
        signals.push({
            type: 'threshold',
            severity: 'warning',
            message: 'Context is 75% full. Consider starting a new conversation.',
            dismissible: true,
        });
    } else if (contextPct >= CONTEXT_THRESHOLD_INFO) {
        signals.push({
            type: 'threshold',
            severity: 'info',
            message: 'Context is 60% full. Responses may start losing earlier details.',
            dismissible: true,
        });
    }

    // 2. Growth rate warning — fires when average upward growth exceeds threshold.
    const avgGrowth = computeAverageGrowth(contextHistory);
    if (avgGrowth !== null && avgGrowth > GROWTH_RATE_WARN_PCT) {
        const remaining = Math.max(0, Math.round((100 - contextPct) / avgGrowth));
        signals.push({
            type: 'growth_warning',
            severity: 'warning',
            message: `Context is filling fast. You will likely hit the limit in ~${remaining} more message${remaining === 1 ? '' : 's'}.`,
            dismissible: true,
        });
    }

    // 3. Stale conversation — long thread with substantial context consumption.
    if (turnCount > STALE_MIN_TURNS && contextPct > STALE_MIN_CONTEXT_PCT) {
        signals.push({
            type: 'stale_conversation',
            severity: 'info',
            message: 'Long conversation detected. Starting fresh often gives better results.',
            dismissible: true,
        });
    }

    // 4. Project hint — ongoing work pattern: enough turns, meaningful context, net growth.
    if (turnCount > PROJECT_HINT_MIN_TURNS && contextPct >= PROJECT_HINT_MIN_CONTEXT_PCT) {
        const netGrowth = contextHistory.length >= 2
            ? contextHistory[contextHistory.length - 1] - contextHistory[0]
            : contextPct;
        if (netGrowth > 0) {
            signals.push({
                type: 'project_hint',
                severity: 'info',
                message: 'Working on something ongoing? A Claude Project keeps your context organized across sessions.',
                dismissible: true,
            });
        }
    }

    return signals;
}

// Returns true if the signal should be suppressed because the user dismissed it.
// Build the dismissed Set by calling signalKey() on each signal the user has dismissed.
export function shouldDismiss(signal: ContextSignal, dismissed: Set<string>): boolean {
    return dismissed.has(signalKey(signal));
}

// Severity rank for priority selection. Higher = shown first.
const SEVERITY_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };

// From a list of active signals, returns the one with the highest severity.
// Returns null if the list is empty. When severities tie, the first match wins.
export function pickTopSignal(signals: ContextSignal[]): ContextSignal | null {
    if (signals.length === 0) return null;
    return signals.reduce((best, s) =>
        (SEVERITY_RANK[s.severity] ?? 0) > (SEVERITY_RANK[best.severity] ?? 0) ? s : best,
    );
}
