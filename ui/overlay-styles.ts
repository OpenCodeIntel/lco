// ui/overlay-styles.ts
// CSS injected as a string into the closed Shadow DOM.
// Exported as a TypeScript constant to bypass WXT's CSS import interception.

export const OVERLAY_CSS = `
:host {
  /* Matches claude.ai dark panel color (~#252527). Solid, no frosted glass. */
  --lco-bg:           #252528;
  --lco-bg-hover:     #2c2c30;
  --lco-text:         #d4d4d8;
  --lco-muted:        #71717a;
  /* Warm orange — echoes Claude's own coral brand color, not purple. */
  --lco-accent:       #d4956a;
  --lco-bar-fill:     #c17a4e;
  --lco-bar-glow:     rgba(193, 122, 78, 0.28);
  --lco-bar-bg:       rgba(193, 122, 78, 0.12);
  --lco-warn-fill:    #f59e0b;
  --lco-warn-glow:    rgba(245, 158, 11, 0.22);
  --lco-warn-bg:      rgba(245, 158, 11, 0.09);
  --lco-border:       rgba(255, 255, 255, 0.06);
  --lco-border-hover: rgba(255, 255, 255, 0.12);
}

@media (prefers-color-scheme: light) {
  :host {
    --lco-bg:           #ffffff;
    --lco-bg-hover:     #f4f4f5;
    --lco-text:         #27272a;
    --lco-muted:        #a1a1aa;
    --lco-accent:       #b36a3a;
    --lco-bar-fill:     #b36a3a;
    --lco-bar-glow:     rgba(179, 106, 58, 0.20);
    --lco-bar-bg:       rgba(179, 106, 58, 0.10);
    --lco-warn-fill:    #d97706;
    --lco-warn-glow:    rgba(217, 119, 6, 0.20);
    --lco-warn-bg:      rgba(217, 119, 6, 0.08);
    --lco-border:       rgba(0, 0, 0, 0.07);
    --lco-border-hover: rgba(0, 0, 0, 0.14);
  }
}

@keyframes lco-enter {
  from { opacity: 0; transform: translateY(10px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0)    scale(1);    }
}

@keyframes lco-bar-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.5; }
}

.lco-widget {
  position: fixed;
  bottom: 88px;
  right: 16px;
  z-index: 2147483647;
  min-width: 210px;
  max-width: 300px;
  padding: 8px 12px;
  background: var(--lco-bg);
  color: var(--lco-text);
  border-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 11px;
  line-height: 1.65;
  box-shadow:
    0 0 0 1px var(--lco-border),
    0 8px 24px rgba(0, 0, 0, 0.35);
  animation: lco-enter 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  transition: box-shadow 0.18s ease, background 0.18s ease;
  cursor: default;
  user-select: none;
}

.lco-widget:hover {
  background: var(--lco-bg-hover);
  box-shadow:
    0 0 0 1px var(--lco-border-hover),
    0 12px 32px rgba(0, 0, 0, 0.45);
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

/* ── Body ── */

.lco-body {
  margin-top: 5px;
}

.lco-row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
  overflow: hidden;
}

.lco-label {
  font-size: 10px;
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
}

.lco-health-dot--healthy   { background: #4ade80; box-shadow: 0 0 4px rgba(74, 222, 128, 0.4); }
.lco-health-dot--degrading { background: #fbbf24; box-shadow: 0 0 4px rgba(251, 191, 36, 0.4); }
.lco-health-dot--critical  { background: #f87171; box-shadow: 0 0 4px rgba(248, 113, 113, 0.4); }

.lco-health-label {
  font-size: 10px;
  font-weight: 600;
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
  height: 100%;
  background: var(--lco-bar-fill);
  border-radius: 99px;
  box-shadow: 0 0 6px var(--lco-bar-glow);
  transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1);
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
  color: var(--lco-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  min-width: 46px;
  text-align: right;
}

/* ── Nudge ── */

@keyframes lco-nudge-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0);    }
}

@keyframes lco-nudge-out {
  from { opacity: 1; transform: translateY(0);    }
  to   { opacity: 0; transform: translateY(-4px); }
}

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
}

.lco-nudge-dismiss:hover { color: var(--lco-text); }

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
  .lco-widget               { animation: none; transition: none; }
  .lco-widget:hover         { transform: none; }
  .lco-bar-fill             { transition: none; }
  .lco-bar-fill.lco-streaming { animation: none; }
  .lco-nudge,
  .lco-nudge--exiting       { animation: none; }
}
`;
