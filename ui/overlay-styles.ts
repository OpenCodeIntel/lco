// ui/overlay-styles.ts
// CSS injected as a string into the closed Shadow DOM.
// Exported as a TypeScript constant to bypass WXT's CSS import interception.
//
// Design language: Claude-aligned. Frosted glass, warm terra cotta accent,
// minimal typography, physics-inspired easing. The widget should feel like
// a native part of claude.ai, not a bolted-on extension.

export const OVERLAY_CSS = `
:host {
  /* Claude terra cotta palette */
  --lco-accent:       #c15f3c;
  --lco-bar-fill:     #c15f3c;
  --lco-bar-glow:     rgba(193, 95, 60, 0.28);
  --lco-bar-bg:       rgba(193, 95, 60, 0.10);
  --lco-warn-fill:    #f59e0b;
  --lco-warn-glow:    rgba(245, 158, 11, 0.22);
  --lco-warn-bg:      rgba(245, 158, 11, 0.09);

  /* Dark mode (default on claude.ai) */
  --lco-bg:           rgba(30, 30, 32, 0.82);
  --lco-bg-hover:     rgba(38, 38, 42, 0.88);
  --lco-text:         #d4d4d8;
  --lco-muted:        #71717a;
  --lco-border:       rgba(255, 255, 255, 0.06);
  --lco-border-hover: rgba(255, 255, 255, 0.12);

  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

@media (prefers-color-scheme: light) {
  :host {
    --lco-bg:           rgba(244, 243, 238, 0.85);
    --lco-bg-hover:     rgba(238, 236, 230, 0.90);
    --lco-text:         #27272a;
    --lco-muted:        #a1a1aa;
    --lco-accent:       #b35a34;
    --lco-bar-fill:     #b35a34;
    --lco-bar-glow:     rgba(179, 90, 52, 0.20);
    --lco-bar-bg:       rgba(179, 90, 52, 0.10);
    --lco-warn-fill:    #d97706;
    --lco-warn-glow:    rgba(217, 119, 6, 0.20);
    --lco-warn-bg:      rgba(217, 119, 6, 0.08);
    --lco-border:       rgba(0, 0, 0, 0.06);
    --lco-border-hover: rgba(0, 0, 0, 0.12);
  }
}

/* ── Animations ── */

@keyframes lco-enter {
  from { opacity: 0; transform: translateY(10px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0)    scale(1);    }
}

@keyframes lco-bar-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.5; }
}

@keyframes lco-dot-pulse {
  0%, 100% { box-shadow: 0 0 4px rgba(248, 113, 113, 0.4); }
  50%      { box-shadow: 0 0 10px rgba(248, 113, 113, 0.7); }
}

@keyframes lco-nudge-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0);    }
}

@keyframes lco-nudge-out {
  from { opacity: 1; transform: translateY(0);    }
  to   { opacity: 0; transform: translateY(-4px); }
}

/* ── Widget container ── */

.lco-widget {
  position: fixed;
  bottom: 88px;
  right: 16px;
  z-index: 2147483647;
  min-width: 210px;
  max-width: 300px;
  padding: 8px 12px;
  background: var(--lco-bg);
  backdrop-filter: blur(16px) saturate(1.4);
  -webkit-backdrop-filter: blur(16px) saturate(1.4);
  color: var(--lco-text);
  border-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 11px;
  line-height: 1.5;
  box-shadow:
    0 0 0 1px var(--lco-border),
    0 4px 12px rgba(0, 0, 0, 0.08),
    0 20px 60px rgba(0, 0, 0, 0.18);
  animation: lco-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  transition: box-shadow 0.2s ease, background 0.2s ease;
  cursor: default;
  user-select: none;
}

.lco-widget:hover {
  background: var(--lco-bg-hover);
  box-shadow:
    0 0 0 1px var(--lco-border-hover),
    0 8px 20px rgba(0, 0, 0, 0.12),
    0 24px 64px rgba(0, 0, 0, 0.22);
}

.lco-widget.lco-collapsed {
  min-width: 0;
  padding: 6px 10px;
}

/* ── Header ── */

.lco-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
}

.lco-title {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--lco-accent);
  opacity: 0.75;
}

.lco-cost-mini {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--lco-accent);
}

/* ── Body (collapsible) ── */

.lco-body {
  margin-top: 5px;
  overflow: hidden;
  max-height: 600px;
  opacity: 1;
  transition: max-height 0.25s ease, opacity 0.2s ease;
}

.lco-body--collapsed {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
  pointer-events: none;
}

/* ── Data rows ── */

.lco-row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
  overflow: hidden;
}

.lco-label {
  font-size: 10px;
  line-height: 1.4;
  color: var(--lco-muted);
  flex-shrink: 0;
}

.lco-value {
  color: var(--lco-text);
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.lco-accent { color: var(--lco-accent); }

.lco-divider {
  height: 1px;
  background: var(--lco-border);
  margin: 5px 0;
}

/* ── Draft estimate (pre-submit) ── */

.lco-draft-row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
  overflow: hidden;
  opacity: 0.7;
}

.lco-draft-row .lco-label {
  font-style: italic;
}

.lco-draft-compare {
  font-size: 9px;
  line-height: 1.3;
  color: var(--lco-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lco-draft-warning {
  font-size: 9px;
  line-height: 1.3;
  color: var(--lco-warn-fill);
}

/* ── Health indicator ── */

.lco-health-row {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 4px 0 2px;
}

.lco-health-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  /* No transition: health state changes are rare (once per conversation).
     Instant swap avoids a paint-layer transition on the main thread. */
}

.lco-health-dot--healthy   { background: #4ade80; box-shadow: 0 0 4px rgba(74, 222, 128, 0.4); }
.lco-health-dot--degrading { background: #fbbf24; box-shadow: 0 0 4px rgba(251, 191, 36, 0.4); }
.lco-health-dot--critical  { background: #f87171; animation: lco-dot-pulse 2s ease-in-out infinite; }

.lco-health-label {
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  /* No transition: color is a paint property; health state changes snap instantly. */
}

.lco-health-label--healthy   { color: #4ade80; }
.lco-health-label--degrading { color: #fbbf24; }
.lco-health-label--critical  { color: #f87171; }

.lco-coaching {
  font-size: 9px;
  line-height: 1.4;
  color: var(--lco-muted);
  margin: 2px 0 3px;
}

/* ── Start fresh button ── */

.lco-start-fresh {
  display: block;
  width: 100%;
  margin: 5px 0 3px;
  padding: 5px 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--lco-accent);
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}

.lco-start-fresh:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.14);
}

.lco-start-fresh:active {
  background: rgba(255, 255, 255, 0.12);
  transform: scale(0.97);
}

.lco-start-fresh:focus-visible {
  outline: 2px solid var(--lco-accent);
  outline-offset: 2px;
}

/* ── Progress bars ── */

.lco-bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
}

.lco-bar-track {
  flex: 1;
  height: 3px;
  background: var(--lco-bar-bg);
  border-radius: 99px;
  overflow: hidden;
}

.lco-bar-track--warn {
  background: var(--lco-warn-bg);
}

.lco-bar-fill {
  width: 100%;
  height: 100%;
  background: var(--lco-bar-fill);
  border-radius: 99px;
  box-shadow: 0 0 6px var(--lco-bar-glow);
  transform-origin: left center;
  transform: scaleX(0);
  will-change: transform;
  /* scaleX is compositor-only: no layout, no paint, native 120fps. */
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.lco-bar-fill--warn {
  background: var(--lco-warn-fill);
  box-shadow: 0 0 6px var(--lco-warn-glow);
}

.lco-bar-fill--healthy   { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.3); }
.lco-bar-fill--degrading { background: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.3); }
.lco-bar-fill--critical  { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.3); }

.lco-bar-fill.lco-streaming {
  animation: lco-bar-pulse 1.2s ease-in-out infinite;
}

.lco-bar-label {
  font-size: 9px;
  line-height: 1.4;
  color: var(--lco-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  min-width: 46px;
  text-align: right;
}

/* ── Nudge ── */

.lco-nudge {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 6px;
  padding: 5px 7px;
  border-radius: 6px;
  font-size: 10px;
  line-height: 1.4;
  animation: lco-nudge-in 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.lco-nudge--info     { background: rgba(99,  179, 237, 0.09); border-left: 2px solid #63b3ed; }
.lco-nudge--warning  { background: rgba(245, 158,  11, 0.11); border-left: 2px solid #f59e0b; }
.lco-nudge--critical { background: rgba(239,  68,  68, 0.11); border-left: 2px solid #ef4444; }

.lco-nudge--exiting {
  animation: lco-nudge-out 0.2s ease forwards;
}

.lco-nudge-msg {
  flex: 1;
  color: var(--lco-text);
}

.lco-nudge-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--lco-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 0 2px;
  line-height: 1;
  transition: color 0.15s ease;
}

.lco-nudge-dismiss:hover { color: var(--lco-text); }

.lco-nudge-dismiss:focus-visible {
  outline: 2px solid var(--lco-accent);
  outline-offset: 2px;
}

/* ── Health warning ── */

.lco-health {
  margin-top: 4px;
  font-size: 10px;
  color: #fbbf24;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Motion-safe fallbacks ── */

@media (prefers-reduced-motion: reduce) {
  .lco-widget                 { animation: none; transition: none; }
  .lco-widget:hover           { transform: none; }
  .lco-body                   { transition: none; }
  .lco-bar-fill               { transition: none; }
  .lco-bar-fill.lco-streaming { animation: none; }
  .lco-health-dot--critical   { animation: none; }
  .lco-start-fresh            { transition: none; }
  .lco-nudge,
  .lco-nudge--exiting         { animation: none; }
  .lco-nudge-dismiss          { transition: none; }
}
`;
