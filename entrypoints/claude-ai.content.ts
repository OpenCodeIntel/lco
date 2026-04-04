// entrypoints/claude-ai.content.ts - Content script for claude.ai (Room 2)
// Thin orchestrator: validates bridge messages, drives state transitions, renders overlay.
// All logic lives in imported modules; this file only wires them together.

import type { LcoBridgeMessage, StoreTokenBatchMessage, StoreMessageLimitMessage, StoreTokenBatchResponse, RecordTurnMessage, FinalizeConversationMessage, SetActiveConvMessage } from '../lib/message-types';
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
async function fetchStoredRecord(conversationId: string): Promise<ConversationRecord | null> {
    try {
        const record: ConversationRecord | null = await browser.runtime.sendMessage({
            type: 'GET_CONVERSATION',
            conversationId,
        });
        return record && record.turnCount > 0 ? record : null;
    } catch {
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

    // Restore state from stored conversation record if one exists.
    // This gives the overlay correct context % and turn count immediately
    // on page load, instead of showing 0% until the user sends a message.
    if (currentConversationId) {
        const record = await fetchStoredRecord(currentConversationId);
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
        if (!event.data || event.data.namespace !== LCO_NAMESPACE) return;
        if (event.data.token !== sessionToken) return;
        if (!isValidBridgeSchema(event.data)) return;

        const msg = event.data as LcoBridgeMessage;

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

            // Persist turn to conversation history in chrome.storage.local.
            // topicHint (first meaningful line of user prompt) flows from inject.ts
            // through the bridge for Conversation DNA.
            if (currentConversationId) {
                browser.runtime.sendMessage({
                    type: 'RECORD_TURN',
                    conversationId: currentConversationId,
                    inputTokens: msg.inputTokens,
                    outputTokens: msg.outputTokens,
                    model: msg.model,
                    contextPct: state.contextPct ?? 0,
                    cost: calculateCost(msg.inputTokens, msg.outputTokens, msg.model),
                    topicHint: msg.topicHint,
                } satisfies RecordTurnMessage).catch((err) => {
                    console.error('[LCO-ERROR] Failed to record conversation turn:', err);
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
            if (currentConversationId && currentConversationId !== newId) {
                browser.runtime.sendMessage({
                    type: 'FINALIZE_CONVERSATION',
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
                fetchStoredRecord(newId).then(record => {
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
