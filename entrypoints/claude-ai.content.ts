// entrypoints/claude-ai.content.ts - Content script for claude.ai (Room 2)
// Thin orchestrator: validates bridge messages, drives state transitions, renders overlay.
// All logic lives in imported modules; this file only wires them together.

import type { LcoBridgeMessage, StoreTokenBatchMessage, StoreMessageLimitMessage, StoreTokenBatchResponse, RecordTurnMessage, FinalizeConversationMessage, SetActiveConvMessage, StoreUsageLimitsMessage, UsageBudgetResult } from '../lib/message-types';
import { LCO_NAMESPACE } from '../lib/message-types';
import { isValidBridgeSchema } from '../lib/bridge-validation';
import { INITIAL_STATE, applyTokenBatch, applyStreamComplete, applyStorageResponse, applyHealthBroken, applyHealthRecovered, applyMessageLimit, applyRestoredConversation, applyDraftEstimate, clearDraftEstimate, applyUsageBudget } from '../lib/overlay-state';
import { computeUsageBudget, getTrackedUtilization } from '../lib/usage-budget';
import { parseUsageResponse } from '../lib/usage-limits-parser';
import { computePreSubmitEstimate, MIN_DRAFT_CHARS } from '../lib/pre-submit';
import { computeAttachmentCost } from '../lib/attachment-cost';
import type { AttachmentDescriptor } from '../lib/attachment-cost';
import { countPdfPages } from '../lib/pdf-page-count';
import { createOverlay } from '../ui/overlay';
import { showEnableBanner } from '../ui/enable-banner';
import { ClaudeAdapter } from '../lib/adapters/claude';
import { analyzeContext, shouldDismiss, signalKey, pickTopSignal } from '../lib/context-intelligence';
import type { ConversationState } from '../lib/context-intelligence';
import { analyzePrompt } from '../lib/prompt-analysis';
import type { PromptCharacteristics, DeltaPromptContext } from '../lib/prompt-analysis';
import { analyzeDelta } from '../lib/delta-coaching';
import type { DeltaCoachInput } from '../lib/delta-coaching';
import { getContextWindowSize, calculateCost } from '../lib/pricing';
import { extractConversationId } from '../lib/conversation-store';
import type { ConversationRecord } from '../lib/conversation-store';
import { computeHealthScore, computeGrowthRate } from '../lib/health-score';
import { buildHandoffSummary } from '../lib/handoff-summary';

export default defineContentScript({
    matches: ['https://claude.ai/*'],
    runAt: 'document_start',
    async main() {
        if (window !== window.top) return;
        const stored = await browser.storage.local.get('lco_enabled_claude');
        if (stored.lco_enabled_claude) {
            await initializeMonitoring();
        } else {
            await showEnableBanner();
        }
    },
});

function freshConvState(): ConversationState {
    return { turnCount: 0, contextPct: 0, contextHistory: [], model: '', contextWindow: 200000 };
}

/**
 * Fetch a stored ConversationRecord for this conversation ID.
 * Returns null if none exists or LCO has never seen this conversation.
 */
async function fetchStoredRecord(orgId: string | null, conversationId: string): Promise<ConversationRecord | null> {
    try {
        const record: ConversationRecord | null = await browser.runtime.sendMessage({
            type: 'GET_CONVERSATION',
            organizationId: orgId ?? '',
            conversationId,
        });
        return record && record.turnCount > 0 ? record : null;
    } catch {
        return null;
    }
}

/**
 * Fetch the Anthropic usage limits for this account, forward to background for
 * storage, and return a UsageBudgetResult (session + weekly utilization with
 * reset metadata), or null on any failure.
 *
 * The usage endpoint returns exact session and weekly utilization with reset
 * timestamps — the same data shown on claude.ai/settings/limits.
 *
 * Called on ORGANIZATION_DETECTED (page load) and after each STREAM_COMPLETE.
 * Callers use result.sessionPct for delta tracking: snapshot the before-value,
 * call this, and subtract to get the exact session cost of the last message.
 * result.weeklyPct drives the overlay weekly-cap bar and the side panel
 * Usage Budget card.
 *
 * Returns null on any failure (network error, malformed response). The caller
 * treats null as "delta uncomputable" and records the turn without a delta.
 */
async function fetchAndStoreUsageLimits(orgId: string): Promise<UsageBudgetResult | null> {
    try {
        const response = await fetch(`/api/organizations/${orgId}/usage`, { credentials: 'same-origin' });
        if (!response.ok) return null;
        const rawJson: unknown = await response.json();

        // The parser is the single source of tier dispatch. It returns null only
        // when the body is not even an object we can inspect; in that case we
        // pretend the request failed and leave any previous render in place.
        const limits = parseUsageResponse(rawJson);
        if (!limits) return null;

        // Forward the typed result to the background. The kind discriminator
        // tells the handler which UsageLimitsData variant to rebuild.
        const storeMessage: StoreUsageLimitsMessage = limits.kind === 'session'
            ? {
                type: 'STORE_USAGE_LIMITS',
                kind: 'session',
                organizationId: orgId,
                fiveHourUtilization: limits.fiveHour.utilization,
                fiveHourResetsAt: limits.fiveHour.resetsAt,
                sevenDayUtilization: limits.sevenDay.utilization,
                sevenDayResetsAt: limits.sevenDay.resetsAt,
            }
            : limits.kind === 'credit'
                ? {
                    type: 'STORE_USAGE_LIMITS',
                    kind: 'credit',
                    organizationId: orgId,
                    monthlyLimitCents: limits.monthlyLimitCents,
                    usedCents: limits.usedCents,
                    utilizationPct: limits.utilizationPct,
                    currency: limits.currency,
                }
                : {
                    type: 'STORE_USAGE_LIMITS',
                    kind: 'unsupported',
                    organizationId: orgId,
                };
        browser.runtime.sendMessage(storeMessage).catch(() => { /* non-critical */ });

        return computeUsageBudget(limits, limits.kind === 'unsupported' ? Date.now() : limits.capturedAt);
    } catch {
        // Network errors are silently ignored; the dashboard shows stale data.
        return null;
    }
}

/**
 * Build local conversation state from a stored record.
 * Uses per-turn contextPct values from TurnRecord when available — these are
 * the real context window fill percentages recorded at each turn end.
 * Falls back to a flat backfill with the provided contextPct for older records
 * that predate per-turn tracking (turns array empty or all zeros).
 */
function buildConvStateFromRecord(record: ConversationRecord, contextPct: number): ConversationState {
    const hasMeaningfulTurnData = record.turns.length > 0 &&
        record.turns.some(t => t.contextPct > 0);

    const lastContextPct = hasMeaningfulTurnData
        ? record.turns[record.turns.length - 1].contextPct
        : contextPct;

    return {
        turnCount: record.turnCount,
        contextPct: lastContextPct,
        contextHistory: hasMeaningfulTurnData
            ? record.turns.map(t => t.contextPct)
            : record.turns.map(() => contextPct),
        model: record.model,
        contextWindow: getContextWindowSize(record.model) || 200000,
    };
}

async function initializeMonitoring(): Promise<void> {
    const sessionToken = crypto.randomUUID();
    const overlay = createOverlay();
    let state = { ...INITIAL_STATE };
    let convState = freshConvState();
    let dismissed = new Set<string>();
    let currentConversationId = extractConversationId(window.location.href);

    // Organization UUID for account isolation. Populated from the first bridge
    // message (inject.ts extracts it from the API URL). Null until first request.
    let currentOrgId: string | null = null;

    // Per-conversation cumulative token tracking.
    // inject.ts only captures the user's latest message text (not the full
    // API input context), so per-message tokens are a fraction of the real
    // context usage. Cumulative totals across all turns approximate the
    // actual conversation size in the context window.
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let cumulativeCost = 0;

    // Generation counter: incremented on each navigation. Async restore callbacks
    // check this to avoid overwriting state from a newer conversation.
    let navGeneration = 0;

    // Tracks how many consecutive short follow-ups the user has sent.
    // Resets on SPA navigation alongside other conversation state.
    let consecutiveShortFollowUps = 0;

    // Whether the last sent prompt demanded precise / exhaustive recall on
    // prior context (code blocks or precision keywords). Used by the Health
    // Agent to shift its per-model warn and critical thresholds earlier, see
    // lib/context-rot-thresholds.ts. Computed in inject.ts on STREAM_COMPLETE
    // and forwarded via the bridge so raw prompt text never crosses worlds.
    // Resets on SPA navigation alongside other conversation state.
    let lastDetailHeavy = false;

    // Last known 5-hour session utilization from the Anthropic usage endpoint.
    // Snapshot before each stream, then read again after STREAM_COMPLETE to
    // compute the exact session % consumed by that message (delta tracking).
    // Null until the first successful usage fetch (ORGANIZATION_DETECTED).
    let lastKnownUtilization: number | null = null;

    // Per-conversation delta history for the Delta Coach Agent.
    // Accumulates deltaUtilization values (session % per turn) as they arrive.
    // Reset on SPA navigation alongside other conversation state.
    let deltaHistory: number[] = [];
    let firstTurnDelta: number | null = null;

    // Cached token economics (medianTokensPer1Pct as plain object, keyed by model).
    // Fetched once per org from the background via GET_TOKEN_ECONOMICS.
    // Cross-conversation: not reset on SPA navigation, only on org change.
    let cachedTokenEconomics: Record<string, number> | null = null;

    // Cached medianPctPerInputToken: session % per input token, per model.
    // Used by the Pre-Submit Agent to predict draft cost from char count.
    let cachedPctPerInputToken: Record<string, number> | null = null;

    // Compose box observer for pre-submit cost estimation.
    let composeBoxRef: HTMLElement | null = null;
    let composeFormRef: HTMLElement | null = null;
    let composeObserver: MutationObserver | null = null;
    let attachmentObserver: MutationObserver | null = null;
    let draftDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let fileChangeListenerAttached = false;

    /**
     * Attachments currently visible in the compose form. Keyed by a stable
     * file fingerprint; values carry the filename (used to detect when the
     * user removes the attachment via the UI; we match the filename text
     * against the rendered form contents and prune entries that disappear).
     *
     * Bytes never leave the browser: image dimensions come from naturalWidth
     * on a blob-URL Image, PDF page counts from a local regex over the file's
     * head and tail windows. The map only holds dimensions and page counts.
     */
    interface TrackedAttachment { filename: string; descriptor: AttachmentDescriptor; }
    const attachmentMap = new Map<string, TrackedAttachment>();

    // Restore state from stored conversation record if one exists.
    // This gives the overlay correct context % and turn count immediately
    // on page load, instead of showing 0% until the user sends a message.
    if (currentConversationId) {
        // Tell background which conversation is active so the side panel
        // dashboard can display it immediately. Without this, SET_ACTIVE_CONV
        // only fires on SPA navigation, leaving the dashboard empty after
        // extension reload or fresh page load.
        browser.runtime.sendMessage({
            type: 'SET_ACTIVE_CONV',
            organizationId: currentOrgId,
            conversationId: currentConversationId,
        } satisfies SetActiveConvMessage).catch(() => { /* non-critical */ });

        // Defer the fetch until the org ID is known (populated by ORGANIZATION_DETECTED).
        // If org ID is still null here, the ORGANIZATION_DETECTED handler will retry.
        const record = currentOrgId ? await fetchStoredRecord(currentOrgId, currentConversationId) : null;
        if (record) {
            cumulativeInput = record.totalInputTokens;
            cumulativeOutput = record.totalOutputTokens;
            cumulativeCost = record.estimatedCost ?? 0;
            // applyRestoredConversation owns the contextPct formula.
            // buildConvStateFromRecord receives it to avoid duplication.
            state = applyRestoredConversation(state, record, null);
            convState = buildConvStateFromRecord(record, state.contextPct ?? 0);
            // Restore path: we don't have the live draft so detail-heavy is
            // false. Model comes from the stored conversation record.
            const health = computeHealthScore({
                contextPct: convState.contextPct,
                turnCount: convState.turnCount,
                growthRate: computeGrowthRate(convState.contextHistory),
                model: convState.model,
                isDetailHeavy: false,
            });
            state = { ...state, health };
        }
    }

    // 5-layer message bridge: Main World (inject.js) → Service Worker
    // Registered synchronously before any await so no events are dropped
    // during the async injectScript / shadow DOM setup window.
    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.source !== window) return;
        if (!event.data || event.data.namespace !== LCO_NAMESPACE) return;
        if (event.data.token !== sessionToken) return;
        if (!isValidBridgeSchema(event.data)) return;

        const msg = event.data as LcoBridgeMessage;

        // Restore conversation state from storage for the given org + conversation.
        // Called when the org ID is first known (ORGANIZATION_DETECTED) or falls
        // back to TOKEN_BATCH/STREAM_COMPLETE. The navGeneration guard prevents a
        // stale async callback from overwriting state after SPA navigation.
        function scheduleConversationRestore(orgId: string, convId: string): void {
            const restoreGen = navGeneration;
            fetchStoredRecord(orgId, convId).then((record) => {
                if (!record || navGeneration !== restoreGen) return;
                cumulativeInput = record.totalInputTokens;
                cumulativeOutput = record.totalOutputTokens;
                cumulativeCost = record.estimatedCost ?? 0;
                state = applyRestoredConversation(state, record, null);
                convState = buildConvStateFromRecord(record, state.contextPct ?? 0);
                // Async restore path. Same reasoning as the synchronous restore
                // block above: detail-heavy unknown -> false; model from record.
                const health = computeHealthScore({
                    contextPct: convState.contextPct,
                    turnCount: convState.turnCount,
                    growthRate: computeGrowthRate(convState.contextHistory),
                    model: convState.model,
                    isDetailHeavy: false,
                });
                state = { ...state, health };
                overlay.render(state);
            }).catch(() => { /* non-critical */ });
        }

        // ORGANIZATION_DETECTED fires on page load from the first API call
        // (before any user message). This gives us the account scope immediately.
        if (msg.type === 'ORGANIZATION_DETECTED') {
            const wasNull = currentOrgId === null;
            const orgChanged = !wasNull && currentOrgId !== msg.organizationId;
            currentOrgId = msg.organizationId;

            // Clear stale token economics when org changes (different account).
            if (orgChanged) {
                cachedTokenEconomics = null;
                cachedPctPerInputToken = null;
            }

            if (wasNull || orgChanged) {
                // Re-send SET_ACTIVE_CONV with the now-known org ID so the
                // side panel can scope its queries to this account.
                browser.runtime.sendMessage({
                    type: 'SET_ACTIVE_CONV',
                    organizationId: currentOrgId,
                    conversationId: currentConversationId,
                } satisfies SetActiveConvMessage).catch(() => {});

                // Restore conversation state now that we have the org ID.
                // The init block skipped this because orgId was null at page load.
                if (currentConversationId) {
                    scheduleConversationRestore(currentOrgId, currentConversationId);
                }

                // Fetch usage limits now that we have the org ID. Populates the
                // Usage Budget card in the side panel and weekly bar on the overlay.
                // Capture the tier-appropriate utilization (session% on Pro,
                // monthly% on Enterprise) as the initial before-snapshot so the
                // first STREAM_COMPLETE can compute a delta in matching units.
                // The unsupported variant has nothing to track or display.
                fetchAndStoreUsageLimits(currentOrgId).then(budget => {
                    if (budget !== null && budget.kind !== 'unsupported') {
                        lastKnownUtilization = getTrackedUtilization(budget);
                        state = applyUsageBudget(state, budget);
                        overlay.render(state);
                    }
                });

                // Pre-fetch token economics for the Delta Coach and Prompt Agent.
                // Cross-conversation medians are expensive to recompute per turn;
                // caching them here means they're ready by the first STREAM_COMPLETE.
                browser.runtime.sendMessage({
                    type: 'GET_TOKEN_ECONOMICS',
                    organizationId: currentOrgId,
                }).then((result: { medianTokensPer1Pct: Record<string, number>; medianPctPerInputToken: Record<string, number> } | null) => {
                    if (result) {
                        cachedTokenEconomics = result.medianTokensPer1Pct;
                        cachedPctPerInputToken = result.medianPctPerInputToken;
                    }
                }).catch(() => { /* non-critical; coaching and pre-submit degrade gracefully */ });
            }
            return; // ORGANIZATION_DETECTED is handled; no further processing.
        }

        // Also capture org ID from TOKEN_BATCH/STREAM_COMPLETE as a fallback
        // in case ORGANIZATION_DETECTED was missed (e.g., inject.ts loaded late).
        if ('organizationId' in msg && typeof msg.organizationId === 'string' && currentOrgId === null) {
            currentOrgId = msg.organizationId;
            if (currentConversationId) {
                browser.runtime.sendMessage({
                    type: 'SET_ACTIVE_CONV',
                    organizationId: currentOrgId,
                    conversationId: currentConversationId,
                } satisfies SetActiveConvMessage).catch(() => {});
                scheduleConversationRestore(currentOrgId, currentConversationId);
            }
        }

        // Pre-send fallback: inject.ts posts DRAFT_ESTIMATE right before the fetch.
        // This guarantees a cost estimate even if the compose box observer is disconnected.
        if (msg.type === 'DRAFT_ESTIMATE') {
            const estimate = computePreSubmitEstimate({
                draftCharCount: msg.draftCharCount,
                model: convState.model || 'claude-sonnet-4-6',
                pctPerInputToken: cachedPctPerInputToken,
                currentSessionPct: lastKnownUtilization ?? 0,
            });
            state = applyDraftEstimate(state, estimate);
            overlay.render(state);
        }

        if (msg.type === 'TOKEN_BATCH') {
            // Clear draft estimate: the message has been sent, stream is starting.
            // Also drop tracked attachments; claude.ai resets the compose form
            // after send, and the next file the user picks will repopulate the
            // map via the input change listener.
            attachmentMap.clear();
            state = clearDraftEstimate(state);
            browser.runtime.sendMessage({
                type: 'STORE_TOKEN_BATCH',
                platform: msg.platform,
                model: msg.model,
                inputTokens: msg.inputTokens,
                outputTokens: msg.outputTokens,
                stopReason: null,
            } satisfies StoreTokenBatchMessage).catch((err) => {
                console.error('[LCO-ERROR] Failed to forward TOKEN_BATCH to background:', err);
            });
            state = applyTokenBatch(state, msg);
            overlay.render(state);
        }

        if (msg.type === 'STREAM_COMPLETE') {
            // Update cumulative session totals for cost and token accounting.
            // cumulativeInput accumulates real per-turn API input counts (which now
            // include conversation history) — used for session totals display and cost.
            cumulativeInput += msg.inputTokens;
            cumulativeOutput += msg.outputTokens;
            cumulativeCost += calculateCost(msg.inputTokens, msg.outputTokens, msg.model) ?? 0;

            const ctxWindow = getContextWindowSize(msg.model) || 200000;

            // Context window fill is the current turn's inputTokens divided by the
            // context window size. With inject.ts now reading the exact input_tokens
            // from the message_start SSE event, msg.inputTokens represents the full
            // context Claude received: system prompt + entire conversation history +
            // current user message. This is the real context window utilization.
            // It grows turn-over-turn as the conversation history accumulates —
            // reflecting the exponential growth that drives hallucination and cost.
            const currentContextPct = ctxWindow > 0
                ? (msg.inputTokens / ctxWindow) * 100
                : 0;

            // Update conversation state before computing health (health depends on turnCount).
            convState = {
                turnCount: convState.turnCount + 1,
                contextPct: currentContextPct,
                contextHistory: [...convState.contextHistory, currentContextPct],
                model: msg.model,
                contextWindow: ctxWindow,
            };

            // Update the cached detail-heavy flag from this turn's prompt
            // characteristics (inject.ts sets msg.isDetailHeavy from the live
            // promptText; raw text never crosses the bridge). The Health
            // Agent reads this to shift its per-model thresholds when the
            // user is asking for precise / exhaustive recall.
            lastDetailHeavy = msg.isDetailHeavy ?? false;

            // Compute full next state in one step, render once.
            state = {
                ...applyStreamComplete(state, msg),
                contextPct: currentContextPct,
                session: {
                    requestCount: convState.turnCount,
                    totalInputTokens: cumulativeInput,
                    totalOutputTokens: cumulativeOutput,
                    totalCost: cumulativeCost,
                },
                health: computeHealthScore({
                    contextPct: currentContextPct,
                    turnCount: convState.turnCount,
                    growthRate: computeGrowthRate(convState.contextHistory),
                    model: msg.model,
                    isDetailHeavy: lastDetailHeavy,
                }),
            };
            overlay.render(state);

            // Track consecutive short follow-ups for the follow_up_chain signal.
            if (msg.isShortFollowUp) {
                consecutiveShortFollowUps++;
            } else {
                consecutiveShortFollowUps = 0;
            }

            // Build prompt characteristics and run the Prompt Agent.
            const promptChars: PromptCharacteristics = {
                promptLength: msg.promptLength ?? 0,
                hasCodeBlock: msg.hasCodeBlock ?? false,
                isShortFollowUp: msg.isShortFollowUp ?? false,
            };
            const promptSignals = analyzePrompt(promptChars, msg.model, consecutiveShortFollowUps);

            // Merge context signals (warning/critical) with prompt signals (info).
            // pickTopSignal ranks by severity, so context health always wins.
            const contextSignals = analyzeContext(convState).filter(s => !shouldDismiss(s, dismissed));
            const allSignals = [
                ...contextSignals,
                ...promptSignals.filter(s => !shouldDismiss(s, dismissed)),
            ];
            const top = pickTopSignal(allSignals);
            if (top) {
                overlay.showNudge(top, () => { dismissed.add(signalKey(top)); });
            } else {
                overlay.hideNudge();
            }

            // Persist turn and compute exact session delta.
            //
            // Delta tracking: snapshot utilization before, fetch Anthropic's usage
            // endpoint after, subtract. This gives the exact 5-hour session percentage
            // consumed by this one message — from Anthropic directly, not estimated.
            //
            // The fetch is the same call that refreshes the side panel budget card, so
            // there is no extra API call: we just capture the returned value this time.
            if (currentConversationId && currentOrgId) {
                // Capture all turn data synchronously before any await. These values
                // are used inside the async callback below; closures over the mutable
                // `msg` reference would be unsafe after the event handler returns.
                const orgId = currentOrgId;
                const convId = currentConversationId;
                const utilizationBefore = lastKnownUtilization;
                const turnInputTokens = msg.inputTokens;
                const turnOutputTokens = msg.outputTokens;
                const turnModel = msg.model;
                const turnContextPct = state.contextPct ?? 0;
                const turnCost = calculateCost(msg.inputTokens, msg.outputTokens, msg.model);
                const turnTopicHint = msg.topicHint;
                const turnPromptChars = promptChars;
                const turnFollowUpCount = consecutiveShortFollowUps;
                const turnConvState = convState;
                const turnDismissed = dismissed;

                // fetchAndStoreUsageLimits catches all errors internally; it never
                // throws. The .then() always runs.
                fetchAndStoreUsageLimits(orgId).then(budgetAfter => {
                    // Tracked utilization is tier-aware: 5-hour session % on Pro,
                    // monthly credit % on Enterprise. The unsupported variant has
                    // nothing to track, so we leave the snapshot null and skip
                    // the delta math entirely.
                    const utilizationAfter = (budgetAfter !== null && budgetAfter.kind !== 'unsupported')
                        ? getTrackedUtilization(budgetAfter)
                        : null;
                    // Update the cached value so the next STREAM_COMPLETE has a
                    // fresh before-snapshot. Only update on valid (non-null) reads.
                    if (utilizationAfter !== null) {
                        lastKnownUtilization = utilizationAfter;
                    }

                    // Delta is valid only when both snapshots exist and usage went up.
                    // A negative or zero delta indicates a session reset between the two
                    // fetches, or a duplicate event — both cases produce null delta.
                    let deltaUtilization: number | null = null;
                    if (
                        utilizationBefore !== null &&
                        utilizationAfter !== null &&
                        utilizationAfter > utilizationBefore
                    ) {
                        deltaUtilization = utilizationAfter - utilizationBefore;
                    }

                    // Apply fresh budget to overlay state. Combine with delta update in
                    // one state object so the render below covers both changes.
                    // Unsupported variants have no UI to render, so they never enter state.
                    if (budgetAfter !== null && budgetAfter.kind !== 'unsupported') {
                        state = applyUsageBudget(state, budgetAfter);
                    }

                    // Update overlay immediately with the exact session cost for
                    // this reply. Re-render so the user sees "X.X% of session" the
                    // moment the usage endpoint responds (typically < 200ms post-stream).
                    if (deltaUtilization !== null) {
                        state = { ...state, lastDeltaUtilization: deltaUtilization };
                    }
                    if (budgetAfter !== null || deltaUtilization !== null) {
                        overlay.render(state);
                    }

                    // Track delta history for the Delta Coach Agent.
                    if (deltaUtilization !== null) {
                        deltaHistory.push(deltaUtilization);
                        if (firstTurnDelta === null) firstTurnDelta = deltaUtilization;
                    }

                    // Second signal pass: re-run agents with delta data.
                    // The first pass (synchronous, above) ran without delta. Now that
                    // we have exact session data, the Delta Coach and enhanced Prompt
                    // Agent can produce data-driven signals that may outrank the initial ones.
                    const deltaCoachInput: DeltaCoachInput = {
                        currentDelta: deltaUtilization,
                        recentDeltas: deltaHistory.slice(-5),
                        sessionPct: utilizationAfter ?? 0,
                        firstTurnDelta,
                        turnCount: turnConvState.turnCount,
                    };
                    const deltaSignals = analyzeDelta(deltaCoachInput)
                        .filter(s => !shouldDismiss(s, turnDismissed));

                    // Build Prompt Agent delta context for model efficiency coaching.
                    let deltaPromptCtx: DeltaPromptContext | undefined;
                    if (deltaUtilization !== null && cachedTokenEconomics) {
                        // Find the Haiku median: try exact key first, then prefix match.
                        const haikuKey = Object.keys(cachedTokenEconomics)
                            .find(k => k.startsWith('claude-haiku'));
                        const haikuMedian = haikuKey ? cachedTokenEconomics[haikuKey] : null;
                        const totalTokens = turnInputTokens + turnOutputTokens;
                        const haikuMedianDelta = (haikuMedian && haikuMedian > 0)
                            ? totalTokens / haikuMedian
                            : null;
                        deltaPromptCtx = { currentDelta: deltaUtilization, haikuMedianDelta };
                    }
                    const deltaPromptSignals = analyzePrompt(
                        turnPromptChars, turnModel, turnFollowUpCount, deltaPromptCtx,
                    ).filter(s => !shouldDismiss(s, turnDismissed));

                    // Merge all delta-powered signals. Context signals from the first
                    // pass are still valid; merge them in so pickTopSignal can compare.
                    const contextSignals2 = analyzeContext(turnConvState)
                        .filter(s => !shouldDismiss(s, turnDismissed));
                    const allDeltaSignals = [
                        ...contextSignals2,
                        ...deltaSignals,
                        ...deltaPromptSignals,
                    ];
                    const deltaNudge = pickTopSignal(allDeltaSignals);
                    if (deltaNudge) {
                        overlay.showNudge(deltaNudge, () => { dismissed.add(signalKey(deltaNudge)); });
                    }

                    browser.runtime.sendMessage({
                        type: 'RECORD_TURN',
                        organizationId: orgId,
                        conversationId: convId,
                        inputTokens: turnInputTokens,
                        outputTokens: turnOutputTokens,
                        model: turnModel,
                        contextPct: turnContextPct,
                        cost: turnCost,
                        topicHint: turnTopicHint,
                        deltaUtilization,
                    } satisfies RecordTurnMessage).catch((err) => {
                        console.error('[LCO-ERROR] Failed to record conversation turn:', err);
                    });
                });
            }

            browser.runtime.sendMessage({
                type: 'STORE_TOKEN_BATCH',
                platform: msg.platform,
                model: msg.model,
                inputTokens: msg.inputTokens,
                outputTokens: msg.outputTokens,
                stopReason: msg.stopReason ?? null,
            } satisfies StoreTokenBatchMessage)
                .then((response: StoreTokenBatchResponse) => {
                    if (!response?.ok || !response.tabState) return;
                    state = applyStorageResponse(state, response.tabState);
                    overlay.render(state);
                })
                .catch((err) => {
                    console.error('[LCO-ERROR] Failed to forward STREAM_COMPLETE to background:', err);
                });
        }

        if (msg.type === 'HEALTH_BROKEN') {
            state = applyHealthBroken(state, msg.message);
            overlay.render(state);
        }

        if (msg.type === 'HEALTH_RECOVERED') {
            state = applyHealthRecovered(state);
            overlay.render(state);
        }

        if (msg.type === 'MESSAGE_LIMIT_UPDATE') {
            browser.runtime.sendMessage({
                type: 'STORE_MESSAGE_LIMIT',
                platform: msg.platform,
                messageLimitUtilization: msg.messageLimitUtilization,
            } satisfies StoreMessageLimitMessage).catch((err) => {
                console.error('[LCO-ERROR] Failed to forward MESSAGE_LIMIT_UPDATE to background:', err);
            });
            state = applyMessageLimit(state, msg.messageLimitUtilization);
            overlay.render(state);
        }
    });

    // Internal BPE token counting relay: inject.ts → background
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'LCO_TOKEN_REQ') return;
        const { id, text } = event.data;
        browser.runtime.sendMessage({ type: 'COUNT_TOKENS', text })
            .then((response: { count?: number }) => {
                const count = typeof response?.count === 'number' ? response.count : 0;
                window.postMessage({ type: 'LCO_TOKEN_RES', id, count }, window.location.origin);
            })
            .catch((err) => {
                console.error('[LCO-ERROR] BPE bridge failed:', err);
                window.postMessage({ type: 'LCO_TOKEN_RES', id, count: 0 }, window.location.origin);
            });
    });

    browser.storage.session.set({
        [`sessionToken_${location.hostname}`]: sessionToken,
    }).catch(() => { /* non-critical */ });

    await injectScript('/inject.js', {
        keepInDom: true,
        modifyScript(script) {
            script.dataset.sessionToken = sessionToken;
            script.dataset.platform = ClaudeAdapter.name;
            script.dataset.injectConfig = JSON.stringify(ClaudeAdapter.injectConfig);
        },
    });

    if (!document.body) {
        await new Promise<void>(resolve => {
            if (document.readyState !== 'loading') resolve();
            else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
        });
    }

    const host = document.createElement('div');
    host.id = 'lco-widget-host';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    overlay.mount(shadow);

    // "Start fresh" flow: build handoff summary, copy to clipboard, navigate to new chat.
    overlay.onStartFresh(async () => {
        try {
            // Fetch the current conversation record from storage (via background).
            let summary = '';
            if (currentConversationId && state.health) {
                const conv = await browser.runtime.sendMessage({
                    type: 'GET_CONVERSATION',
                    organizationId: currentOrgId ?? '',
                    conversationId: currentConversationId,
                });
                if (conv) {
                    summary = buildHandoffSummary({ conversation: conv, health: state.health });
                }
            }

            // Copy summary to clipboard so the user can paste it.
            if (summary) {
                await navigator.clipboard.writeText(summary).catch(() => {
                    // Clipboard may fail without user gesture focus; non-critical.
                });
            }

            // Navigate to new chat. claude.ai SPA responds to /new.
            window.location.href = 'https://claude.ai/new';
        } catch (err) {
            console.error('[LCO-ERROR] Start fresh flow failed:', err);
        }
    });

    // Compose box observer: finds ProseMirror editor, reads text from the
    // contenteditable only (the form parent's textContent includes attachment
    // card filenames; reading text from the form would inflate the char count
    // by the length of every attached filename), tracks attachments via the
    // file input's change event, debounces pre-submit estimates.

    /**
     * Find the compose region: the smallest reasonable ancestor of the editor
     * that wraps the attachment cards and the file input. claude.ai's modern
     * React build does not always use a <form> element, so we accept three
     * shapes: an actual FORM/FIELDSET (legacy), any ancestor whose subtree
     * contains an <input type=file> (current), or a wide-but-bounded ancestor
     * walk if neither matches. Returns null when no plausible parent exists,
     * which only happens when the editor is detached from the DOM.
     */
    function findComposeRegion(el: HTMLElement): HTMLElement | null {
        let p: HTMLElement | null = el.parentElement;
        let widestSeen: HTMLElement | null = null;
        for (let i = 0; i < 8 && p; i++) {
            const t = p.tagName;
            if (t === 'FIELDSET' || t === 'FORM') return p;
            if (p.querySelector('input[type=file]')) return p;
            widestSeen = p;
            p = p.parentElement;
        }
        return widestSeen;
    }

    function fileKey(file: File): string {
        return `${file.name}|${file.size}|${file.lastModified}`;
    }

    /**
     * Read an image's pixel dimensions via a transient blob URL. The bytes
     * never leave the browser: the URL is local-only and revoked as soon as
     * the load handler fires.
     */
    function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
        return new Promise(resolve => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve({ width: img.naturalWidth, height: img.naturalHeight });
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
            };
            img.src = url;
        });
    }

    /**
     * Read enough of a PDF to locate its page-tree root: the first 1 MB plus
     * the last 64 KB. This covers the common cases (catalog near the head,
     * trailer at the tail) without slurping a 32 MB file into memory. Bytes
     * stay local; nothing crosses the bridge.
     */
    async function readPdfPageCount(file: File): Promise<number | null> {
        const HEAD = 1024 * 1024;
        const TAIL = 64 * 1024;

        try {
            if (file.size <= HEAD + TAIL) {
                return countPdfPages(new Uint8Array(await file.arrayBuffer()));
            }
            const headBuf = await file.slice(0, HEAD).arrayBuffer();
            const tailBuf = await file.slice(file.size - TAIL).arrayBuffer();
            const merged = new Uint8Array(HEAD + TAIL);
            merged.set(new Uint8Array(headBuf), 0);
            merged.set(new Uint8Array(tailBuf), HEAD);
            return countPdfPages(merged);
        } catch {
            return null;
        }
    }

    function recomputeDraft(): void {
        if (!composeBoxRef) return;

        // Read text only from the contenteditable. Reading from the form
        // parent would include attachment-card filenames in the char count.
        const text = composeBoxRef.textContent ?? '';

        // Reconcile the attachment map against what is currently rendered:
        // when the user removes an attachment via the UI, claude.ai removes
        // its card from the DOM; the filename disappears from the form's
        // textContent. Drop tracked entries whose filename is no longer there.
        if (composeFormRef) {
            const formText = composeFormRef.textContent ?? '';
            for (const [key, tracked] of attachmentMap) {
                if (!formText.includes(tracked.filename)) {
                    attachmentMap.delete(key);
                }
            }
        }

        const model = convState.model || 'claude-sonnet-4-6';
        const attachments: AttachmentDescriptor[] = [];
        for (const tracked of attachmentMap.values()) attachments.push(tracked.descriptor);
        const cost = computeAttachmentCost(attachments, model);

        if (text.length < MIN_DRAFT_CHARS && attachmentMap.size === 0) {
            if (state.draftEstimate !== null) {
                state = clearDraftEstimate(state);
                overlay.render(state);
            }
            return;
        }

        state = applyDraftEstimate(state, computePreSubmitEstimate({
            draftCharCount: text.length,
            model,
            pctPerInputToken: cachedPctPerInputToken,
            currentSessionPct: lastKnownUtilization ?? 0,
            currentContextPct: state.contextPct ?? 0,
            attachmentTokensLow: cost.totalTokensLow,
            attachmentTokensHigh: cost.totalTokensHigh,
            attachmentBreakdown: cost.breakdown,
            attachmentWarnings: cost.warnings,
            hasUnknownImage: cost.hasUnknownImage,
            hasPdf: cost.hasPdf,
        }));
        overlay.render(state);
    }

    function onComposeInput(): void {
        if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
        draftDebounceTimer = setTimeout(() => { recomputeDraft(); }, 500);
    }

    function handleFileChange(event: Event): void {
        const input = event.target as HTMLInputElement | null;
        if (!input || input.tagName !== 'INPUT' || input.type !== 'file' || !input.files) return;

        // Snapshot files now: input.files can mutate before async reads resolve.
        const files = Array.from(input.files);
        for (const file of files) {
            const key = fileKey(file);
            if (attachmentMap.has(key)) continue;

            if (file.type.startsWith('image/')) {
                readImageDimensions(file).then(dims => {
                    if (!dims || dims.width <= 0 || dims.height <= 0) return;
                    attachmentMap.set(key, {
                        filename: file.name,
                        descriptor: {
                            kind: 'image',
                            width: dims.width,
                            height: dims.height,
                            sourceLabel: file.name,
                            fileSize: file.size,
                        },
                    });
                    recomputeDraft();
                });
            } else if (file.type === 'application/pdf') {
                readPdfPageCount(file).then(pages => {
                    // pages can be null when the PDF is encrypted, fully
                    // compressed, or malformed. Track it anyway so the user
                    // sees the file is registered; the agent renders an
                    // unknown-cost row rather than dropping the attachment.
                    attachmentMap.set(key, {
                        filename: file.name,
                        descriptor: {
                            kind: 'pdf',
                            pageCount: pages !== null && pages > 0 ? pages : null,
                            sourceLabel: file.name,
                            fileSize: file.size,
                        },
                    });
                    recomputeDraft();
                });
            }
        }
    }

    function discoverComposeBox(): void {
        const box = document.querySelector<HTMLElement>('div.ProseMirror[contenteditable="true"]')
            ?? document.querySelector<HTMLElement>('div[contenteditable="true"][data-placeholder]');
        if (box) {
            composeBoxRef = box;
            box.addEventListener('input', onComposeInput);
            const parent = findComposeRegion(box);
            if (parent) {
                composeFormRef = parent;
                // Attachment-card adds and removes flow through DOM mutations.
                // Reuse onComposeInput so the same debounce path covers both.
                attachmentObserver = new MutationObserver(onComposeInput);
                attachmentObserver.observe(parent, { childList: true, subtree: true });
            }
            composeObserver?.disconnect();
            composeObserver = null;
            return;
        }
        if (!composeObserver) {
            composeObserver = new MutationObserver(discoverComposeBox);
            composeObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    discoverComposeBox();

    // Document-level capture for file-input change events. claude.ai's compose
    // form is a deeply-nested set of divs (no <form> tag) and the file input
    // can live outside the editor's immediate ancestor chain, so per-region
    // attachment was missing the event entirely. Capture-phase at document
    // level catches every change before it bubbles, regardless of where the
    // input sits relative to the editor. The listener is attached once and
    // never removed; it is harmless when no compose box has been discovered.
    if (!fileChangeListenerAttached) {
        document.documentElement.addEventListener('change', handleFileChange, true);
        fileChangeListenerAttached = true;
    }

    // Reset overlay, conversation state, and dismissed nudges on SPA navigation (Chrome 102+).
    // Also finalize the previous conversation and detect the new one.
    if ('navigation' in window) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).navigation.addEventListener('navigatesuccess', () => {
            const newId = extractConversationId(window.location.href);

            // Finalize the old conversation if navigating to a different one.
            if (currentConversationId && currentConversationId !== newId && currentOrgId) {
                browser.runtime.sendMessage({
                    type: 'FINALIZE_CONVERSATION',
                    organizationId: currentOrgId,
                    conversationId: currentConversationId,
                } satisfies FinalizeConversationMessage).catch((err) => {
                    console.error('[LCO-ERROR] Failed to finalize conversation:', err);
                });
            }
            currentConversationId = newId;

            // Notify background immediately so the side panel dashboard can
            // refresh without waiting for the first RECORD_TURN of the new conversation.
            browser.runtime.sendMessage({
                type: 'SET_ACTIVE_CONV',
                organizationId: currentOrgId,
                conversationId: newId ?? null,
            } satisfies SetActiveConvMessage).catch(() => { /* non-critical */ });

            state = { ...INITIAL_STATE };
            convState = freshConvState();
            cumulativeInput = 0;
            cumulativeOutput = 0;
            cumulativeCost = 0;
            consecutiveShortFollowUps = 0;
            lastDetailHeavy = false;
            deltaHistory = [];
            firstTurnDelta = null;
            dismissed = new Set();
            const thisGeneration = ++navGeneration;
            overlay.render(state);
            overlay.hideNudge();

            // Re-discover the compose box: SPA navigation replaces the DOM.
            // The document-level file-change listener stays attached across
            // navigations (document.documentElement is stable), so we do not
            // reset fileChangeListenerAttached here.
            if (composeObserver) { composeObserver.disconnect(); composeObserver = null; }
            if (attachmentObserver) { attachmentObserver.disconnect(); attachmentObserver = null; }
            composeBoxRef = null;
            composeFormRef = null;
            attachmentMap.clear();
            if (draftDebounceTimer) { clearTimeout(draftDebounceTimer); draftDebounceTimer = null; }
            discoverComposeBox();

            // Restore state from storage for the new conversation (if previously tracked).
            // The generation guard prevents this callback from overwriting state if the
            // user navigated again (or started streaming) before the fetch completed.
            if (newId) {
                fetchStoredRecord(currentOrgId, newId).then(record => {
                    if (!record || navGeneration !== thisGeneration) return;
                    cumulativeInput = record.totalInputTokens;
                    cumulativeOutput = record.totalOutputTokens;
                    cumulativeCost = record.estimatedCost ?? 0;
                    state = applyRestoredConversation(state, record, null);
                    convState = buildConvStateFromRecord(record, state.contextPct ?? 0);
                    // SPA navigation restore. New conversation, no live draft
                    // text, so detail-heavy resets to false here. Model from
                    // the stored record. The next STREAM_COMPLETE on the new
                    // conversation will refresh both fields.
                    const health = computeHealthScore({
                        contextPct: convState.contextPct,
                        turnCount: convState.turnCount,
                        growthRate: computeGrowthRate(convState.contextHistory),
                        model: convState.model,
                        isDetailHeavy: false,
                    });
                    state = { ...state, health };
                    overlay.render(state);
                });
            }
        });
    }
}
