// entrypoints/claude-ai.content.ts - Content script for claude.ai (Room 2)
// Thin orchestrator: validates bridge messages, drives state transitions, renders overlay.
// All logic lives in imported modules; this file only wires them together.

import type { LcoBridgeMessage, StoreTokenBatchMessage, StoreMessageLimitMessage, StoreTokenBatchResponse, RecordTurnMessage, FinalizeConversationMessage, SetActiveConvMessage, StoreUsageLimitsMessage } from '../lib/message-types';
import { LCO_NAMESPACE } from '../lib/message-types';
import { isValidBridgeSchema } from '../lib/bridge-validation';
import { INITIAL_STATE, applyTokenBatch, applyStreamComplete, applyStorageResponse, applyHealthBroken, applyHealthRecovered, applyMessageLimit, applyRestoredConversation } from '../lib/overlay-state';
import { createOverlay } from '../ui/overlay';
import { showEnableBanner } from '../ui/enable-banner';
import { ClaudeAdapter } from '../lib/adapters/claude';
import { analyzeContext, shouldDismiss, signalKey, pickTopSignal } from '../lib/context-intelligence';
import type { ConversationState } from '../lib/context-intelligence';
import { analyzePrompt } from '../lib/prompt-analysis';
import type { PromptCharacteristics } from '../lib/prompt-analysis';
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
 * storage, and return the 5-hour session utilization percentage.
 *
 * The usage endpoint returns exact session and weekly utilization with reset
 * timestamps — the same data shown on claude.ai/settings/limits.
 *
 * Called on ORGANIZATION_DETECTED (page load) and after each STREAM_COMPLETE.
 * The returned utilization value is used for delta tracking: the caller snapshots
 * the before-value, calls this, and subtracts to get the exact session cost of
 * the last message.
 *
 * Returns null on any failure (network error, malformed response). The caller
 * treats null as "delta uncomputable" and records the turn without a delta.
 */
async function fetchAndStoreUsageLimits(orgId: string): Promise<number | null> {
    try {
        const response = await fetch(`/api/organizations/${orgId}/usage`, { credentials: 'same-origin' });
        if (!response.ok) return null;
        const data = await response.json() as {
            five_hour?: { utilization?: number; resets_at?: string };
            seven_day?: { utilization?: number; resets_at?: string };
        };
        const fiveHour = data.five_hour;
        const sevenDay = data.seven_day;
        if (
            !fiveHour || typeof fiveHour.utilization !== 'number' || typeof fiveHour.resets_at !== 'string' ||
            !sevenDay || typeof sevenDay.utilization !== 'number' || typeof sevenDay.resets_at !== 'string'
        ) return null;
        browser.runtime.sendMessage({
            type: 'STORE_USAGE_LIMITS',
            organizationId: orgId,
            fiveHourUtilization: fiveHour.utilization,
            fiveHourResetsAt: fiveHour.resets_at,
            sevenDayUtilization: sevenDay.utilization,
            sevenDayResetsAt: sevenDay.resets_at,
        } satisfies StoreUsageLimitsMessage).catch(() => { /* non-critical */ });
        return fiveHour.utilization;
    } catch {
        // Network errors are silently ignored; the dashboard shows stale data.
        return null;
    }
}

/**
 * Build local conversation state from a stored record.
 * Uses the contextPct computed by applyRestoredConversation (cumulative tokens)
 * to backfill contextHistory, since per-turn values stored before cumulative
 * tracking are near-zero and produce meaningless growth rate data.
 */
function buildConvStateFromRecord(record: ConversationRecord, contextPct: number): ConversationState {
    return {
        turnCount: record.turnCount,
        contextPct,
        // Backfill history with the current cumulative value for all turns.
        // Stored per-turn values are near-zero (pre-cumulative tracking).
        // A flat history produces a zero growth rate, which is correct:
        // we have no real per-turn data to compute growth from.
        contextHistory: record.turns.map(() => contextPct),
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

    // Last known 5-hour session utilization from the Anthropic usage endpoint.
    // Snapshot before each stream, then read again after STREAM_COMPLETE to
    // compute the exact session % consumed by that message (delta tracking).
    // Null until the first successful usage fetch (ORGANIZATION_DETECTED).
    let lastKnownUtilization: number | null = null;

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
            const health = computeHealthScore({
                contextPct: convState.contextPct,
                turnCount: convState.turnCount,
                growthRate: computeGrowthRate(convState.contextHistory),
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
                const health = computeHealthScore({
                    contextPct: convState.contextPct,
                    turnCount: convState.turnCount,
                    growthRate: computeGrowthRate(convState.contextHistory),
                });
                state = { ...state, health };
                overlay.render(state);
            }).catch(() => { /* non-critical */ });
        }

        // ORGANIZATION_DETECTED fires on page load from the first API call
        // (before any user message). This gives us the account scope immediately.
        if (msg.type === 'ORGANIZATION_DETECTED') {
            const wasNull = currentOrgId === null;
            currentOrgId = msg.organizationId;
            if (wasNull) {
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
                // Usage Budget card in the side panel immediately on load.
                // Capture the returned utilization as the initial before-snapshot
                // so the first STREAM_COMPLETE can compute a delta.
                fetchAndStoreUsageLimits(currentOrgId).then(u => {
                    if (u !== null) lastKnownUtilization = u;
                });
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

        if (msg.type === 'TOKEN_BATCH') {
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
            // Update cumulative totals for this conversation.
            cumulativeInput += msg.inputTokens;
            cumulativeOutput += msg.outputTokens;
            cumulativeCost += calculateCost(msg.inputTokens, msg.outputTokens, msg.model) ?? 0;

            const ctxWindow = getContextWindowSize(msg.model) || 200000;
            const cumulativeContextPct = ctxWindow > 0
                ? ((cumulativeInput + cumulativeOutput) / ctxWindow) * 100
                : 0;

            // Update conversation state before computing health (health depends on turnCount).
            convState = {
                turnCount: convState.turnCount + 1,
                contextPct: cumulativeContextPct,
                contextHistory: [...convState.contextHistory, cumulativeContextPct],
                model: msg.model,
                contextWindow: ctxWindow,
            };

            // Compute full next state in one step, render once.
            state = {
                ...applyStreamComplete(state, msg),
                contextPct: cumulativeContextPct,
                session: {
                    requestCount: convState.turnCount,
                    totalInputTokens: cumulativeInput,
                    totalOutputTokens: cumulativeOutput,
                    totalCost: cumulativeCost,
                },
                health: computeHealthScore({
                    contextPct: cumulativeContextPct,
                    turnCount: convState.turnCount,
                    growthRate: computeGrowthRate(convState.contextHistory),
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

                // fetchAndStoreUsageLimits catches all errors internally; it never
                // throws. The .then() always runs.
                fetchAndStoreUsageLimits(orgId).then(utilizationAfter => {
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

                    // Update overlay immediately with the exact session cost for
                    // this reply. Re-render so the user sees "X.X% of session" the
                    // moment the usage endpoint responds (typically < 200ms post-stream).
                    if (deltaUtilization !== null) {
                        state = { ...state, lastDeltaUtilization: deltaUtilization };
                        overlay.render(state);
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
            dismissed = new Set();
            const thisGeneration = ++navGeneration;
            overlay.render(state);
            overlay.hideNudge();

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
                    const health = computeHealthScore({
                        contextPct: convState.contextPct,
                        turnCount: convState.turnCount,
                        growthRate: computeGrowthRate(convState.contextHistory),
                    });
                    state = { ...state, health };
                    overlay.render(state);
                });
            }
        });
    }
}
