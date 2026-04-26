// ui/overlay.ts
// Overlay DOM factory. No knowledge of message types, chrome APIs, or business logic.
// createOverlay() returns a handle with two methods:
//   mount(shadow)  — builds the DOM tree inside the given shadow root (call once)
//   render(state)  — reflects OverlayState onto the DOM (safe to call before mount)

import { OVERLAY_CSS } from './overlay-styles';
import type { OverlayState } from '../lib/overlay-state';
import type { ContextSignal } from '../lib/context-intelligence';
import { classifyZone } from '../lib/usage-budget';

export interface OverlayHandle {
    mount(shadow: ShadowRoot): void;
    render(state: OverlayState): void;
    showNudge(signal: ContextSignal, onDismiss: () => void): void;
    hideNudge(): void;
    /** Register the callback for the "Start fresh" button. Called once at setup. */
    onStartFresh(callback: () => void): void;
}

function fmt(n: number): string {
    return n.toLocaleString('en-US');
}

function fmtCost(c: number | null): string {
    if (c === null) return '—';
    if (c < 0.00001) return '$0.00*';
    return `$${c.toFixed(4)}`;
}

export function createOverlay(): OverlayHandle {
    // DOM refs — null until mount() is called. render() is a no-op until then.
    let overlayWidget: HTMLDivElement | null = null;
    let elCurrentRequest: HTMLElement | null = null;
    let elHealthRow: HTMLElement | null = null;
    let elHealthDot: HTMLElement | null = null;
    let elHealthLabel: HTMLElement | null = null;
    let elContextRow: HTMLElement | null = null;
    let elContextFill: HTMLElement | null = null;
    let elContextLabel: HTMLElement | null = null;
    let elCoaching: HTMLElement | null = null;
    let elStartFresh: HTMLButtonElement | null = null;
    let startFreshCallback: (() => void) | null = null;
    let elLimitRow: HTMLElement | null = null;
    let elLimitFill: HTMLElement | null = null;
    let elLimitLabel: HTMLElement | null = null;
    let elDivider: HTMLElement | null = null;
    let elSessionRow: HTMLElement | null = null;
    let elSession: HTMLElement | null = null;
    let elNudge: HTMLElement | null = null;
    let elNudgeMsg: HTMLElement | null = null;
    let elNudgeDismiss: HTMLButtonElement | null = null;
    let elHealth: HTMLElement | null = null;
    let elCostMini: HTMLElement | null = null;
    let elHealthDotMini: HTMLElement | null = null;
    let nudgeHideTimer: ReturnType<typeof setTimeout> | null = null;
    let elDraftRow: HTMLElement | null = null;
    let elDraftValue: HTMLElement | null = null;
    let elDraftCompare: HTMLElement | null = null;
    let elDraftWarning: HTMLElement | null = null;
    let elWeeklyRow: HTMLElement | null = null;
    let elWeeklyFill: HTMLElement | null = null;
    let elWeeklyLabel: HTMLElement | null = null;

    function mount(shadow: ShadowRoot): void {
        const style = document.createElement('style');
        style.textContent = OVERLAY_CSS;
        shadow.appendChild(style);

        const widget = document.createElement('div');
        widget.className = 'lco-widget';
        widget.style.display = 'none'; // hidden until first TOKEN_BATCH
        overlayWidget = widget;

        // Header — always visible, click to collapse/expand
        const header = document.createElement('div');
        header.className = 'lco-header';

        const title = document.createElement('span');
        title.className = 'lco-title';
        title.textContent = 'SAAR';

        const costMini = document.createElement('span');
        costMini.className = 'lco-cost-mini';
        costMini.style.display = 'none'; // shown only when collapsed
        elCostMini = costMini;

        // Health dot shown in collapsed pill — sole health signal when minimized.
        const healthDotMini = document.createElement('span');
        healthDotMini.className = 'lco-health-dot';
        healthDotMini.style.display = 'none';
        elHealthDotMini = healthDotMini;

        header.appendChild(title);
        header.appendChild(costMini);
        header.appendChild(healthDotMini);
        widget.appendChild(header);

        // Body — collapsible
        const body = document.createElement('div');
        body.className = 'lco-body';

        // Draft estimate row: pre-submit cost preview (above "this reply")
        const draftRow = document.createElement('div');
        draftRow.className = 'lco-draft-row';
        draftRow.style.display = 'none';
        elDraftRow = draftRow;
        const lblDraft = document.createElement('span');
        lblDraft.className = 'lco-label';
        lblDraft.textContent = 'draft';
        const valDraft = document.createElement('span');
        valDraft.className = 'lco-value';
        elDraftValue = valDraft;
        draftRow.appendChild(lblDraft);
        draftRow.appendChild(valDraft);
        body.appendChild(draftRow);

        // Draft model comparison (hidden unless cost > 5%)
        const draftCompare = document.createElement('div');
        draftCompare.className = 'lco-draft-compare';
        draftCompare.style.display = 'none';
        elDraftCompare = draftCompare;
        body.appendChild(draftCompare);

        // Draft warning (hidden unless projected total >= 90%)
        const draftWarning = document.createElement('div');
        draftWarning.className = 'lco-draft-warning';
        draftWarning.style.display = 'none';
        elDraftWarning = draftWarning;
        body.appendChild(draftWarning);

        // Last request row
        const rowLast = document.createElement('div');
        rowLast.className = 'lco-row';
        const lblLast = document.createElement('span');
        lblLast.className = 'lco-label';
        lblLast.textContent = 'this reply';
        const valLast = document.createElement('span');
        valLast.className = 'lco-value lco-accent';
        valLast.textContent = '—';
        elCurrentRequest = valLast;
        rowLast.appendChild(lblLast);
        rowLast.appendChild(valLast);
        body.appendChild(rowLast);

        // Health indicator: colored dot + label
        const healthRow = document.createElement('div');
        healthRow.className = 'lco-health-row';
        healthRow.style.display = 'none';
        elHealthRow = healthRow;
        const healthDot = document.createElement('span');
        healthDot.className = 'lco-health-dot';
        elHealthDot = healthDot;
        const healthLabel = document.createElement('span');
        healthLabel.className = 'lco-health-label';
        elHealthLabel = healthLabel;
        healthRow.appendChild(healthDot);
        healthRow.appendChild(healthLabel);
        body.appendChild(healthRow);

        // Context window bar (now below health indicator)
        const ctxRow = document.createElement('div');
        ctxRow.className = 'lco-bar-row';
        ctxRow.style.display = 'none';
        elContextRow = ctxRow;
        const ctxTrack = document.createElement('div');
        ctxTrack.className = 'lco-bar-track';
        const ctxFill = document.createElement('div');
        ctxFill.className = 'lco-bar-fill';
        ctxFill.style.transform = 'scaleX(0)';
        elContextFill = ctxFill;
        ctxTrack.appendChild(ctxFill);
        const ctxLabel = document.createElement('span');
        ctxLabel.className = 'lco-bar-label';
        ctxLabel.textContent = '—% ctx';
        elContextLabel = ctxLabel;
        ctxRow.appendChild(ctxTrack);
        ctxRow.appendChild(ctxLabel);
        body.appendChild(ctxRow);

        // Coaching text (below context bar, from health score)
        const coaching = document.createElement('div');
        coaching.className = 'lco-coaching';
        coaching.style.display = 'none';
        elCoaching = coaching;
        body.appendChild(coaching);

        // "Start fresh" button (visible when Degrading or Critical)
        const freshBtn = document.createElement('button');
        freshBtn.className = 'lco-start-fresh';
        freshBtn.textContent = 'Start fresh';
        freshBtn.style.display = 'none';
        freshBtn.addEventListener('click', () => {
            if (startFreshCallback) startFreshCallback();
        });
        elStartFresh = freshBtn;
        body.appendChild(freshBtn);

        // Message limit bar
        const limitRow = document.createElement('div');
        limitRow.className = 'lco-bar-row';
        limitRow.style.display = 'none';
        elLimitRow = limitRow;
        const limitTrack = document.createElement('div');
        limitTrack.className = 'lco-bar-track lco-bar-track--warn';
        const limitFill = document.createElement('div');
        limitFill.className = 'lco-bar-fill lco-bar-fill--warn';
        limitFill.style.transform = 'scaleX(0)';
        elLimitFill = limitFill;
        limitTrack.appendChild(limitFill);
        const limitLabel = document.createElement('span');
        limitLabel.className = 'lco-bar-label';
        limitLabel.textContent = '—% limit';
        elLimitLabel = limitLabel;
        limitRow.appendChild(limitTrack);
        limitRow.appendChild(limitLabel);
        body.appendChild(limitRow);

        // Weekly cap bar — hidden until usageBudget is available
        const weeklyRow = document.createElement('div');
        weeklyRow.className = 'lco-bar-row lco-weekly-row';
        weeklyRow.style.display = 'none';
        elWeeklyRow = weeklyRow;
        const weeklyTrack = document.createElement('div');
        weeklyTrack.className = 'lco-bar-track';
        const weeklyFill = document.createElement('div');
        weeklyFill.className = 'lco-bar-fill';
        weeklyFill.style.transform = 'scaleX(0)';
        elWeeklyFill = weeklyFill;
        weeklyTrack.appendChild(weeklyFill);
        const weeklyLabel = document.createElement('span');
        weeklyLabel.className = 'lco-bar-label';
        weeklyLabel.textContent = '—% weekly';
        elWeeklyLabel = weeklyLabel;
        weeklyRow.appendChild(weeklyTrack);
        weeklyRow.appendChild(weeklyLabel);
        body.appendChild(weeklyRow);

        // Divider — hidden until first request completes
        const divider = document.createElement('div');
        divider.className = 'lco-divider';
        divider.style.display = 'none';
        elDivider = divider;
        body.appendChild(divider);

        // Session row — hidden until first request completes
        const rowSession = document.createElement('div');
        rowSession.className = 'lco-row';
        rowSession.style.display = 'none';
        elSessionRow = rowSession;
        const lblSession = document.createElement('span');
        lblSession.className = 'lco-label';
        lblSession.textContent = 'total';
        const valSession = document.createElement('span');
        valSession.className = 'lco-value';
        valSession.textContent = '—';
        elSession = valSession;
        rowSession.appendChild(lblSession);
        rowSession.appendChild(valSession);
        body.appendChild(rowSession);

        // Nudge — hidden by default, shown by showNudge()
        const nudge = document.createElement('div');
        nudge.style.display = 'none';
        elNudge = nudge;
        const nudgeMsg = document.createElement('span');
        nudgeMsg.className = 'lco-nudge-msg';
        elNudgeMsg = nudgeMsg;
        const nudgeDismiss = document.createElement('button');
        nudgeDismiss.className = 'lco-nudge-dismiss';
        nudgeDismiss.setAttribute('aria-label', 'Dismiss');
        nudgeDismiss.textContent = '×';
        elNudgeDismiss = nudgeDismiss;
        nudge.appendChild(nudgeMsg);
        nudge.appendChild(nudgeDismiss);
        body.appendChild(nudge);

        // Health warning — hidden by default
        const health = document.createElement('div');
        health.className = 'lco-health';
        health.style.display = 'none';
        elHealth = health;
        body.appendChild(health);

        widget.appendChild(body);
        shadow.appendChild(widget);

        // Collapse/expand toggle — DOM-only concern, lives here
        let collapsed = false;
        header.addEventListener('click', () => {
            collapsed = !collapsed;
            body.classList.toggle('lco-body--collapsed', collapsed);
            costMini.style.display = collapsed ? '' : 'none';
            healthDotMini.style.display = collapsed ? '' : 'none';
            widget.classList.toggle('lco-collapsed', collapsed);
        });
    }

    function render(state: OverlayState): void {
        if (!overlayWidget) return;

        // Reveal widget on first data arrival or when draft estimate is available.
        if ((state.lastRequest !== null || state.draftEstimate !== null) && overlayWidget.style.display === 'none') {
            overlayWidget.style.display = '';
        }

        // Draft estimate: pre-submit cost preview.
        if (elDraftRow && elDraftValue) {
            const draft = state.draftEstimate;
            if (draft) {
                elDraftRow.style.display = '';
                if (draft.estimatedSessionPct !== null) {
                    elDraftValue.textContent =
                        `~${fmt(draft.estimatedTokens)} tokens  ~${draft.estimatedSessionPct.toFixed(1)}% of session`;
                } else {
                    elDraftValue.textContent = `~${fmt(draft.estimatedTokens)} tokens`;
                }
            } else {
                elDraftRow.style.display = 'none';
                elDraftValue.textContent = '';
            }
        }
        if (elDraftCompare) {
            const comparisons = state.draftEstimate?.modelComparisons ?? [];
            if (comparisons.length > 0) {
                elDraftCompare.textContent = comparisons
                    .map(c => `${c.label}: ~${c.estimatedPct.toFixed(1)}%`)
                    .join('  ');
                elDraftCompare.style.display = '';
            } else {
                elDraftCompare.style.display = 'none';
            }
        }
        if (elDraftWarning) {
            const warning = state.draftEstimate?.warning ?? null;
            if (warning) {
                elDraftWarning.textContent = warning;
                elDraftWarning.style.display = '';
            } else {
                elDraftWarning.style.display = 'none';
            }
        }

        if (elCurrentRequest && state.lastRequest) {
            const { inputTokens, outputTokens, cost } = state.lastRequest;
            // Lead with exact tier-appropriate utilization when available
            // (Anthropic endpoint, not estimated). The label tracks the budget
            // variant so an Enterprise user sees "% of monthly" instead of the
            // misleading "% of session" — the underlying number is monthly
            // credit utilization on that tier.
            // Falls back to token/cost display when delta has not yet resolved.
            if (state.lastDeltaUtilization !== null) {
                const window = state.usageBudget?.kind === 'credit' ? 'monthly' : 'session';
                elCurrentRequest.textContent =
                    `${state.lastDeltaUtilization.toFixed(1)}% of ${window} · ${fmtCost(cost)}`;
            } else {
                elCurrentRequest.textContent =
                    `~${fmt(inputTokens)} in · ~${fmt(outputTokens)} out · ${fmtCost(cost)}`;
            }
        }

        // Health indicator: show the three-state label with colored dot.
        if (elHealthRow && elHealthDot && elHealthLabel) {
            const hasHealth = state.health !== null;
            elHealthRow.style.display = hasHealth ? '' : 'none';
            if (hasHealth) {
                const { level, label } = state.health!;
                elHealthDot.className = `lco-health-dot lco-health-dot--${level}`;
                elHealthLabel.textContent = label;
                elHealthLabel.className = `lco-health-label lco-health-label--${level}`;
            }
        }

        // Context bar: still shows the raw percentage for users who want detail.
        if (elContextRow && elContextFill && elContextLabel) {
            const visible = state.contextPct !== null && state.contextPct > 0.1;
            elContextRow.style.display = visible ? '' : 'none';
            if (visible) {
                const pct = Math.min(state.contextPct!, 100);
                elContextFill.style.transform = `scaleX(${pct / 100})`;
                elContextLabel.textContent = `${pct.toFixed(0)}%`;
                // Color the bar based on health level.
                const level = state.health?.level ?? 'healthy';
                elContextFill.className = `lco-bar-fill lco-bar-fill--${level}`;
                elContextFill.classList.toggle('lco-streaming', state.streaming);
            }
        }

        // Coaching text from the health score.
        if (elCoaching) {
            if (state.health && state.health.level !== 'healthy') {
                elCoaching.textContent = state.health.coaching;
                elCoaching.style.display = '';
            } else {
                elCoaching.style.display = 'none';
            }
        }

        // "Start fresh" button: visible when Degrading or Critical.
        // Critical gets a filled variant; degrading keeps the outline.
        if (elStartFresh) {
            const showFresh = state.health !== null && state.health.level !== 'healthy';
            elStartFresh.style.display = showFresh ? '' : 'none';
            elStartFresh.classList.toggle('lco-start-fresh--critical', state.health?.level === 'critical');
        }

        if (elLimitRow && elLimitFill && elLimitLabel) {
            const visible = state.messageLimitUtilization !== null;
            elLimitRow.style.display = visible ? '' : 'none';
            if (visible) {
                const pct = Math.min(state.messageLimitUtilization! * 100, 100);
                elLimitFill.style.transform = `scaleX(${pct / 100})`;
                elLimitLabel.textContent = `${pct.toFixed(0)}% limit`;
            }
        }

        if (elWeeklyRow && elWeeklyFill && elWeeklyLabel) {
            // Only the session tier exposes a weekly window. On credit and
            // unsupported variants the bar would be meaningless (Enterprise has
            // a monthly pool surfaced in the side panel; unsupported has nothing
            // to show), so we keep the row hidden in those cases.
            const budget = state.usageBudget;
            const visible = budget !== null && budget.kind === 'session';
            elWeeklyRow.style.display = visible ? '' : 'none';
            if (visible) {
                const pct = Math.min(Math.max(budget.weeklyPct, 0), 100);
                elWeeklyFill.style.transform = `scaleX(${pct / 100})`;
                elWeeklyFill.className = `lco-bar-fill lco-bar-fill--${classifyZone(pct)}`;
                elWeeklyLabel.textContent = `${Math.round(pct)}% weekly`;
            }
        }

        const sessionVisible = state.session.requestCount > 0;
        if (elDivider) elDivider.style.display = sessionVisible ? '' : 'none';
        if (elSessionRow) elSessionRow.style.display = sessionVisible ? '' : 'none';
        if (elSession && sessionVisible) {
            const { requestCount, totalInputTokens, totalOutputTokens, totalCost } = state.session;
            const total = totalInputTokens + totalOutputTokens;
            const turnLabel = requestCount === 1 ? 'turn' : 'turns';
            elSession.textContent =
                `${requestCount} ${turnLabel} · ~${fmt(total)} tok · ${fmtCost(totalCost)}`;
        }

        if (elHealth) {
            if (state.healthBroken) {
                elHealth.textContent = `⚠ ${state.healthBroken}`;
                elHealth.style.display = '';
            } else {
                elHealth.style.display = 'none';
            }
        }

        // Collapsed pill: show session total (not last reply cost).
        // Cost color stays terra cotta regardless of health state — dot is the sole health signal.
        if (elCostMini && state.session.requestCount > 0) {
            elCostMini.textContent = fmtCost(state.session.totalCost);
        }

        // Collapsed health dot: mirrors the expanded dot color.
        if (elHealthDotMini) {
            const level = state.health?.level ?? 'healthy';
            elHealthDotMini.className = `lco-health-dot lco-health-dot--${level}`;
        }
    }

    function showNudge(signal: ContextSignal, onDismiss: () => void): void {
        if (!elNudge || !elNudgeMsg || !elNudgeDismiss) return;

        // Cancel any in-progress hide animation before showing new content.
        if (nudgeHideTimer !== null) {
            clearTimeout(nudgeHideTimer);
            nudgeHideTimer = null;
        }

        elNudge.className = `lco-nudge lco-nudge--${signal.severity}`;
        elNudgeMsg.textContent = signal.message;
        elNudgeDismiss.style.display = signal.dismissible ? '' : 'none';

        // Replace dismiss listener with a fresh one bound to the current signal.
        const freshDismiss = elNudgeDismiss.cloneNode(true) as HTMLButtonElement;
        elNudgeDismiss.replaceWith(freshDismiss);
        elNudgeDismiss = freshDismiss;
        elNudgeDismiss.addEventListener('click', () => {
            onDismiss();
            hideNudge();
        }, { once: true });

        elNudge.style.display = '';
    }

    function hideNudge(): void {
        if (!elNudge) return;
        elNudge.classList.add('lco-nudge--exiting');
        nudgeHideTimer = setTimeout(() => {
            if (elNudge) {
                elNudge.style.display = 'none';
                elNudge.classList.remove('lco-nudge--exiting');
            }
            nudgeHideTimer = null;
        }, 200);
    }

    function onStartFresh(callback: () => void): void {
        startFreshCallback = callback;
    }

    return { mount, render, showNudge, hideNudge, onStartFresh };
}
