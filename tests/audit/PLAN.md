# QA Audit Test Plan

## Directly testable (pure functions, no browser deps)

### lib/pricing.ts
- `lookupModel(modelName)` -> known model returns pricing, unknown returns null, empty string returns null, case-insensitive
- `calculateCost(input, output, model)` -> correct math, null for unknown model, null for negative tokens, linear scaling
- `getContextWindowSize(model)` -> known model returns correct size, unknown returns 200000

### lib/format.ts
- `formatTokens(n)` -> thresholds at 1000 and 1000000, edge cases (0, NaN, Infinity, negative)
- `formatCost(cost, decimals)` -> null returns "$0.00*", number formatting, decimal control
- `formatModel(model)` -> known pattern extraction, unknown passthrough
- `formatRelativeTime(ts, now)` -> just now, minutes, hours, yesterday, date format, future timestamps

### lib/health-score.ts
- `computeHealthScore(input)` -> all 6 rules with boundary values
- `computeGrowthRate(contextHistory)` -> empty, single, flat, growing, declining, mixed

### lib/context-intelligence.ts
- `analyzeContext(state)` -> threshold signals at 60/75/90, growth warning, stale conversation, project hint
- `signalKey(signal)` -> format "type:severity"
- `shouldDismiss(signal, dismissed)` -> match and no-match
- `pickTopSignal(signals)` -> empty, single, priority ranking

### lib/delta-coaching.ts
- `analyzeDelta(input)` -> burn rate (warning/critical), expensive message, cost trajectory, insufficient data

### lib/prompt-analysis.ts
- `classifyModelTier(model)` -> opus/sonnet/haiku/unknown
- `analyzePrompt(chars, model, followUps, delta?)` -> model suggestion, large paste, follow-up chain

### lib/pre-submit.ts
- `computePreSubmitEstimate(input)` -> null below MIN_DRAFT_CHARS, token estimation, session % prediction, model comparisons, warning zone

### lib/token-economics.ts
- `computeTokenEconomics(deltas)` -> median calculation, MIN_SAMPLES gate, zero-delta exclusion, per-model grouping

### lib/overlay-state.ts
- `applyTokenBatch`, `applyStreamComplete`, `applyStorageResponse`, `applyHealthBroken`, `applyHealthRecovered`, `applyMessageLimit`, `applyRestoredConversation`, `applyDraftEstimate`, `clearDraftEstimate` -> state transition correctness, immutability

### lib/bridge-validation.ts
- `isValidBridgeSchema(data)` -> all message types, missing fields, wrong types, prototype pollution

### lib/usage-budget.ts
- `classifyZone(pct)` -> boundary values at 50/75/90
- `computeUsageBudget(limits, now)` -> zone classification, status label, reset countdown

### lib/conversation-store.ts (pure utilities only)
- `extractOrganizationId(url)` -> valid/invalid URLs
- `extractConversationId(url)` -> chat and API URLs, invalid
- `todayDateString(now)` -> date formatting
- `isoWeekId(timestamp)` -> week calculation
- `extractTopicHint(promptText)` -> greeting skip, code block skip, length truncation, empty

### lib/handoff-summary.ts
- `buildHandoffSummary(ctx)` -> critical/degrading/healthy health levels, with/without DNA
- `deduplicateHints(hints)` -> duplicate removal by first 30 chars

## Testable with mocks
- `conversation-store.ts` CRUD functions -> inject in-memory StorageArea via setStorage()
  (Already covered by existing tests; audit focuses on pure functions and edge cases)

## Not unit-testable (needs browser/extension environment)
- `entrypoints/inject.ts` -> runs in MAIN world, IIFE with no exports, SSE interception
- `entrypoints/claude-ai.content.ts` -> extension content script, chrome.runtime, postMessage bridge
- `entrypoints/background.ts` -> service worker, chrome.storage.session, js-tiktoken
- `ui/overlay.ts`, `ui/overlay-styles.ts`, `ui/enable-banner.ts` -> DOM manipulation in Shadow DOM
- `entrypoints/sidepanel/` -> React side panel

## Import strategy
- Relative paths from tests/audit/ to lib/: `../../lib/module`
- No path aliases needed (vitest.config.ts has none)
- No setup file needed for pure function tests
- vitest globals enabled (describe, test, expect available without import)
- For vi utilities: `import { vi } from 'vitest'`

## Prior audit findings to verify
- HIGH-001: BPE token bridge security bypass -> test bridge-validation.ts for LCO_TOKEN_REQ/LCO_TOKEN_RES
- HIGH-002: COUNT_TOKENS unbounded input -> cannot unit test (background.ts), document as untestable
- HIGH-003: React in production bundles -> build inspection via bash
