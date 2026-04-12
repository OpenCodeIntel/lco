// lib/delta-coaching.ts
// Delta Coach Agent: analyzes per-turn session utilization deltas and produces
// coaching signals backed by exact Anthropic data.
// No DOM refs, no chrome APIs, no side effects. Pure functions only.
//
// ── Role in the multi-agent architecture ──────────────────────────────────────
//
// Each lib/ module is an agent with a single responsibility and a clean interface.
// The content script (claude-ai.content.ts) is the orchestrator that wires agents.
//
// | Agent              | Module                  | Input               | Output           |
// |--------------------|-------------------------|---------------------|------------------|
// | Intelligence Agent | context-intelligence.ts | ConversationState   | ContextSignal[]  |
// | Prompt Agent       | prompt-analysis.ts      | PromptChars + model | ContextSignal[]  |
// | **Delta Coach**    | **delta-coaching.ts**   | **DeltaCoachInput** | **ContextSignal[]** |
// | Health Agent       | health-score.ts         | contextPct, etc.    | HealthScore      |
// | Pricing Agent      | pricing.ts              | model, tokens       | cost (USD)       |
// | Memory Agent       | conversation-store.ts   | conversationId      | ConversationRecord |
// | Token Economics    | token-economics.ts      | UsageDelta[]        | medians per model |
//
// ── Agent contract ───────────────────────────────────────────────────────────
//
// Input:  DeltaCoachInput (session utilization deltas from Anthropic's usage endpoint)
// Output: ContextSignal[] with types: burn_rate, expensive_message, cost_trajectory
//
// Severity levels:
//   burn_rate:         warning (< 15 msg remaining) or critical (< 5 msg remaining)
//   expensive_message: info (current delta > 2x median)
//   cost_trajectory:   warning (per-message cost doubled since conversation start)
//
// Delta Coach signals participate in the same pickTopSignal() ranking as all other
// agents. burn_rate (critical) will outrank all other signals. cost_trajectory
// (warning) ties with Intelligence Agent threshold warnings; first match wins.
//
// ── Data flow ────────────────────────────────────────────────────────────────
//
// The content script captures deltaUtilization after each STREAM_COMPLETE:
//   utilizationBefore (cached from previous fetch)
//   utilizationAfter  (fetched from /api/organizations/{orgId}/usage)
//   delta = after - before
//
// The orchestrator accumulates deltas per conversation and passes them to
// analyzeDelta() along with the current session utilization percentage.
// The agent never fetches data or reads storage; all data is passed in.
//
// ── Why a separate agent instead of expanding the Intelligence Agent ─────────
//
// The Intelligence Agent operates on ConversationState (BPE-estimated context
// window data). Delta data comes from a different source (Anthropic's exact
// session utilization endpoint). Mixing the two data sources in one agent would
// blur the boundary between "approximate context window fill" and "exact session
// cost." Separate agents keep each data source and its coaching logic isolated.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextSignal } from './context-intelligence';

// ── Types ────────────────────────────────────────────────────────────────────

/** Input to the Delta Coach Agent. All data is passed in by the orchestrator. */
export interface DeltaCoachInput {
    /** Session % consumed by this turn. Null if delta was unavailable. */
    currentDelta: number | null;
    /** Recent deltaUtilization values for this conversation, oldest first. */
    recentDeltas: number[];
    /** Current 5-hour session utilization (0-100), from Anthropic's usage endpoint. */
    sessionPct: number;
    /** deltaUtilization of the first turn in this conversation. Null if first turn had no delta. */
    firstTurnDelta: number | null;
    /** Number of turns completed in the current conversation. */
    turnCount: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Warn when fewer than 15 messages estimated remaining.
 * 15 is roughly 2 focused exchanges (question + follow-up + clarification per exchange).
 * Below this, the user should plan their exit or start fresh.
 */
export const BURN_RATE_WARN_REMAINING = 15;

/**
 * Critical when fewer than 5 messages remaining.
 * At 5 messages, the user needs to wrap up or start fresh immediately.
 */
export const BURN_RATE_CRITICAL_REMAINING = 5;

/**
 * Minimum delta samples before computing a meaningful median for burn rate.
 * 3 is the minimum for a representative median. Lower than token economics'
 * MIN_SAMPLES (5) because we're working with recent per-conversation data,
 * not cross-conversation historical medians.
 */
export const BURN_RATE_MIN_DELTAS = 3;

/**
 * Don't predict burn rate when session is barely used. At < 50%, predictions
 * are unstable because the user might change behavior (switch topics, models).
 */
export const BURN_RATE_MIN_SESSION_PCT = 50;

/**
 * A message is "expensive" when it costs more than 2x the recent median.
 * 2x is the threshold where the difference is noticeable and worth flagging.
 */
export const EXPENSIVE_MSG_MULTIPLIER = 2;

/**
 * Minimum deltas needed to compute the median for expensive-message detection.
 * Same rationale as BURN_RATE_MIN_DELTAS: 3 samples for a meaningful median.
 */
export const EXPENSIVE_MSG_MIN_DELTAS = 3;

/**
 * Conversation cost has doubled since the first turn. At 2x, context replay
 * cost is visibly growing. This is the signal that teaches users the core
 * mechanic: every message replays the full history, so later messages cost more.
 */
export const TRAJECTORY_MULTIPLIER = 2;

/**
 * Don't fire cost trajectory until enough turns have passed for the trend
 * to be meaningful. 5 turns is roughly 2.5 exchanges.
 */
export const TRAJECTORY_MIN_TURNS = 5;

// ── Utility ──────────────────────────────────────────────────────────────────

/**
 * Compute the median of a non-empty array of numbers.
 * The array is sorted in place. For even-length arrays, returns the average
 * of the two middle values. Callers must ensure the array is non-empty.
 *
 * Not shared with token-economics.ts because agents are self-contained.
 * Small duplication is preferable to a shared utility coupling two agents.
 */
function median(values: number[]): number {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    if (values.length % 2 === 1) return values[mid];
    return (values[mid - 1] + values[mid]) / 2;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Analyze session utilization deltas and produce coaching signals.
 *
 * Returns an empty array when input data is insufficient (null delta, too few
 * samples, session barely used). Callers never need to guard against crashes;
 * the agent degrades gracefully by simply producing fewer signals.
 *
 * @param input - DeltaCoachInput assembled by the content script orchestrator.
 * @returns ContextSignal[] with types: burn_rate, expensive_message, cost_trajectory.
 */
export function analyzeDelta(input: DeltaCoachInput): ContextSignal[] {
    const signals: ContextSignal[] = [];
    const { currentDelta, recentDeltas, sessionPct, firstTurnDelta, turnCount } = input;

    // 1. Burn rate prediction: how many messages until the session limit?
    //
    // Uses the median of recent deltas as the per-message cost estimate.
    // Median is more stable than mean: a single large paste won't skew the
    // prediction the way it would skew an average.
    if (recentDeltas.length >= BURN_RATE_MIN_DELTAS && sessionPct > BURN_RATE_MIN_SESSION_PCT) {
        const avgDelta = median([...recentDeltas]);
        if (avgDelta > 0) {
            const messagesRemaining = Math.floor((100 - sessionPct) / avgDelta);
            if (messagesRemaining < BURN_RATE_CRITICAL_REMAINING) {
                signals.push({
                    type: 'burn_rate',
                    severity: 'critical',
                    message: `At your current pace, ~${messagesRemaining} message${messagesRemaining === 1 ? '' : 's'} until your session limit.`,
                    dismissible: false,
                });
            } else if (messagesRemaining < BURN_RATE_WARN_REMAINING) {
                signals.push({
                    type: 'burn_rate',
                    severity: 'warning',
                    message: `At your current pace, ~${messagesRemaining} messages until your session limit.`,
                    dismissible: true,
                });
            }
        }
    }

    // 2. Expensive message alert: did this message cost significantly more than usual?
    //
    // Compares the current delta to the median of recent deltas. Only fires when
    // the current message is an outlier (> 2x median). This teaches users to notice
    // when they do something expensive (large paste, file upload, long prompt).
    if (
        currentDelta !== null &&
        recentDeltas.length >= EXPENSIVE_MSG_MIN_DELTAS
    ) {
        const recentMedian = median([...recentDeltas]);
        if (recentMedian > 0 && currentDelta > EXPENSIVE_MSG_MULTIPLIER * recentMedian) {
            signals.push({
                type: 'expensive_message',
                severity: 'info',
                message: `That message cost ${currentDelta.toFixed(1)}% of your session (your average is ${recentMedian.toFixed(1)}%). Large prompts or file uploads consume more.`,
                dismissible: true,
            });
        }
    }

    // 3. Conversation cost trajectory: is per-message cost growing over time?
    //
    // Compares the current turn's delta to the first turn's delta. When cost
    // doubles, it means context replay overhead is significant. This is the most
    // important coaching signal: it teaches users that every message replays the
    // full conversation history, so later messages cost more than earlier ones.
    if (
        turnCount > TRAJECTORY_MIN_TURNS &&
        firstTurnDelta !== null &&
        firstTurnDelta > 0 &&
        currentDelta !== null &&
        currentDelta > TRAJECTORY_MULTIPLIER * firstTurnDelta
    ) {
        signals.push({
            type: 'cost_trajectory',
            severity: 'warning',
            message: `Messages in this chat now cost ~${currentDelta.toFixed(1)}% each (vs ~${firstTurnDelta.toFixed(1)}% when you started). Each message replays the full history. Starting fresh resets the cost.`,
            dismissible: true,
        });
    }

    return signals;
}
