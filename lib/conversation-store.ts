// lib/conversation-store.ts
// Persistent conversation storage against chrome.storage.local.
// Stores metadata only (tokens, model, cost, timestamps). Never stores conversation text.
// All functions accept an optional storage parameter for testability.

import { calculateCost } from './pricing';
import type { UsageLimitsData } from './message-types';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface TurnRecord {
    turnNumber: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
    contextPct: number;
    cost: number | null;
    completedAt: number;
    /**
     * 5-hour session utilization consumed by this turn, in percentage points.
     * null when before/after utilization snapshots were unavailable (e.g. first
     * load before any limits fetch, or a session reset between snapshots).
     * Optional for backwards compatibility with records written before LCO-34.
     */
    deltaUtilization?: number | null;
}

/**
 * One delta record per completed turn, stored in the append-only delta log.
 * Used by the Token Economics agent to derive median tokens-per-1% per model.
 * Only records with a valid (non-null) delta are stored; null deltas are
 * dropped at the call site in background.ts.
 */
export interface UsageDelta {
    conversationId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    /** 5-hour session utilization consumed, in percentage points. Always > 0 when stored. */
    deltaUtilization: number;
    cost: number | null;
    timestamp: number;
}

/**
 * Incremental lossy summary of a conversation's content.
 * Built from the first line of each user prompt as the conversation progresses.
 * Works for any conversation topic: code, writing, research, casual.
 * The original prompt text is processed in memory and discarded; only these
 * derived fields persist.
 */
export interface ConversationDNA {
    /** First prompt's first meaningful line. What started this conversation. */
    subject: string;
    /** Latest prompt's first meaningful line. Where we left off. */
    lastContext: string;
    /** First meaningful line of each user prompt, newest first. Max 20. */
    hints: string[];
}

export const MAX_DNA_HINTS = 20;

export const EMPTY_DNA: Readonly<ConversationDNA> = {
    subject: '',
    lastContext: '',
    hints: [],
};

export interface ConversationRecord {
    id: string;
    startedAt: number;
    lastActiveAt: number;
    finalized: boolean;
    turnCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    peakContextPct: number;
    lastContextPct: number;
    model: string;
    estimatedCost: number | null;
    /** Per-turn metadata, oldest first. Capped at MAX_TURNS_PER_RECORD. */
    turns: TurnRecord[];
    /** Incremental content summary. Updated on every turn. */
    dna: ConversationDNA;
    _v: 1;
}

export interface ModelBreakdown {
    model: string;
    conversationCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCost: number | null;
}

export interface DailySummary {
    date: string;
    conversationCount: number;
    totalTurns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCost: number | null;
    avgPeakContextPct: number;
    criticalConversations: number;
    modelBreakdown: ModelBreakdown[];
    computedAt: number;
    _v: 1;
}

export interface WeeklySummary {
    weekId: string;
    weekStart: string;
    weekEnd: string;
    conversationCount: number;
    totalTurns: number;
    totalTokens: number;
    estimatedCost: number | null;
    avgTurnsPerConversation: number;
    heaviestDay: number;
    modelBreakdown: ModelBreakdown[];
    criticalConversations: number;
    computedAt: number;
    _v: 1;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_TURNS_PER_RECORD = 50;
export const RETENTION_DAYS = 90;
export const CRITICAL_CONTEXT_PCT = 80;
// Append-only delta log cap. Oldest records are pruned when this is exceeded.
// At ~50 bytes per record, 500 entries is ~25 KB, well within storage.local limits.
export const MAX_USAGE_DELTAS = 500;

// Storage key builders. All keys are scoped to an accountId (organization UUID)
// so multiple Claude accounts sharing one browser get isolated data.
// Legacy keys (without accountId) are checked as a read-through migration fallback.
function assertAccountId(accountId: string): void {
    if (!accountId) throw new Error('[LCO] accountId required for scoped storage key');
}
function convKey(accountId: string, convId: string): string { assertAccountId(accountId); return `conv:${accountId}:${convId}`; }
function convIndexKey(accountId: string): string { assertAccountId(accountId); return `convIndex:${accountId}`; }
function dailyKey(accountId: string, date: string): string { assertAccountId(accountId); return `daily:${accountId}:${date}`; }
function dailyIndexKey(accountId: string): string { assertAccountId(accountId); return `dailyIndex:${accountId}`; }
function weeklyKey(accountId: string, weekId: string): string { assertAccountId(accountId); return `weekly:${accountId}:${weekId}`; }
function weeklyIndexKey(accountId: string): string { assertAccountId(accountId); return `weeklyIndex:${accountId}`; }
// Single record per account; overwritten on each fetch (no append, no prune needed).
function usageLimitsKey(accountId: string): string { assertAccountId(accountId); return `usageLimits:${accountId}`; }
// Append-only delta log, capped at MAX_USAGE_DELTAS. Key referenced in claude-ai.content.ts.
function usageDeltasKey(accountId: string): string { assertAccountId(accountId); return `usageDeltas:${accountId}`; }

// Legacy (pre-account-isolation) key builders for read-through migration.
function legacyConvKey(convId: string): string { return `conv:${convId}`; }
const LEGACY_CONV_INDEX_KEY = 'convIndex';
function legacyDailyKey(date: string): string { return `daily:${date}`; }
const LEGACY_DAILY_INDEX_KEY = 'dailyIndex';

// ── Storage abstraction ───────────────────────────────────────────────────────

// Minimal interface matching chrome.storage.local. Tests provide a mock.
export interface StorageArea {
    get(keys: string | string[] | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
}

let _storage: StorageArea | null = null;

/**
 * Set the storage backend. Must be called once at startup before any CRUD calls.
 * The background script calls this with chrome.storage.local (or browser.storage.local).
 * Tests call this with an in-memory mock.
 */
export function setStorage(storage: StorageArea): void {
    _storage = storage;
}

function store(): StorageArea {
    if (!_storage) {
        throw new Error('[LCO] conversation-store: setStorage() must be called before any storage operations');
    }
    return _storage;
}

// ── Pure utility functions ────────────────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const CONV_ID_PATTERNS = [
    /\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /\/chat_conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
];

const ORG_ID_PATTERN = /\/organizations\/([0-9a-f-]+)\//i;

/** Extract the organization UUID from a claude.ai API URL. Returns null if not found. */
export function extractOrganizationId(url: string): string | null {
    const match = url.match(ORG_ID_PATTERN);
    return match ? match[1].toLowerCase() : null;
}

/** Extract the conversation UUID from a claude.ai URL. Returns null if not found. */
export function extractConversationId(url: string): string | null {
    for (const pattern of CONV_ID_PATTERNS) {
        const match = url.match(pattern);
        if (match) return match[1].toLowerCase();
    }
    return null;
}

/** Today's date as YYYY-MM-DD in local timezone. */
export function todayDateString(now: number = Date.now()): string {
    const d = new Date(now);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** ISO week ID for a timestamp, e.g. "2026-W14". */
export function isoWeekId(timestamp: number): string {
    const d = new Date(timestamp);
    // ISO week: Monday is first day. Jan 4 is always in week 1.
    const dayOfWeek = d.getDay() || 7; // Convert Sunday=0 to 7
    d.setDate(d.getDate() + 4 - dayOfWeek); // Set to nearest Thursday
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Date string for a given day offset from a base date. */
function dateStringForOffset(baseDate: string, offset: number): string {
    const d = new Date(baseDate + 'T00:00:00');
    d.setDate(d.getDate() + offset);
    return todayDateString(d.getTime());
}

/** Get the Monday of the ISO week containing the given date string. */
function weekMondayFromId(weekId: string): string {
    // Parse "2026-W14" to find the Monday of that week.
    const [yearStr, weekStr] = weekId.split('-W');
    const year = Number(yearStr);
    const week = Number(weekStr);
    // Jan 4 is always in week 1. Find the Monday of week 1, then add (week-1)*7 days.
    const jan4 = new Date(year, 0, 4);
    const dayOfWeek = jan4.getDay() || 7;
    const mondayWeek1 = new Date(jan4);
    mondayWeek1.setDate(jan4.getDate() - dayOfWeek + 1);
    mondayWeek1.setDate(mondayWeek1.getDate() + (week - 1) * 7);
    return todayDateString(mondayWeek1.getTime());
}

/**
 * Extract the first meaningful line from a user prompt.
 * Skips greetings, empty lines, and very short fragments.
 * Returns the line truncated to MAX_HINT_CHARS, or empty string if nothing useful found.
 * This runs in inject.ts (inlined) and is also exported here for testing.
 */
export const MAX_HINT_CHARS = 120;

// Word boundary (\b) prevents "no" from matching "Now", "hi" from matching "His", etc.
// "Please" is intentionally excluded: "Please review..." is a real request, not filler.
const SKIP_PATTERNS = /^(hey|hi|hello|thanks|thank you|ok|okay|sure|yes|no|great|awesome|perfect|cool|nice|got it|sounds good)\b/i;

export function extractTopicHint(promptText: string): string {
    if (!promptText) return '';
    const lines = promptText.split('\n');
    let inCodeBlock = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) continue;                   // Skip lines inside code blocks
        if (line.length < 10) continue;              // Too short to be meaningful
        if (SKIP_PATTERNS.test(line)) continue;      // Greeting or filler
        return line.length > MAX_HINT_CHARS ? line.slice(0, MAX_HINT_CHARS) + '...' : line;
    }
    // Fallback: return the first non-empty line if nothing passed the filter.
    for (const raw of lines) {
        const line = raw.trim();
        if (line.length > 0 && !line.startsWith('```')) {
            return line.length > MAX_HINT_CHARS ? line.slice(0, MAX_HINT_CHARS) + '...' : line;
        }
    }
    return '';
}

// ── Index helpers ─────────────────────────────────────────────────────────────

async function readIndex(indexKey: string): Promise<string[]> {
    const data = await store().get(indexKey);
    const arr = data[indexKey];
    return Array.isArray(arr) ? arr as string[] : [];
}

async function addToIndex(indexKey: string, id: string): Promise<void> {
    const index = await readIndex(indexKey);
    if (!index.includes(id)) {
        index.unshift(id);
        await store().set({ [indexKey]: index });
    }
}

async function removeFromIndex(indexKey: string, ids: Set<string>): Promise<void> {
    const index = await readIndex(indexKey);
    const filtered = index.filter((id) => !ids.has(id));
    await store().set({ [indexKey]: filtered });
}

// ── Conversation CRUD ─────────────────────────────────────────────────────────

/**
 * Get a single conversation by UUID. Returns null if not found.
 * Checks the account-scoped key first; falls back to the legacy global key
 * for pre-migration data (and migrates it on read).
 */
export async function getConversation(accountId: string, id: string): Promise<ConversationRecord | null> {
    const key = convKey(accountId, id);
    const data = await store().get(key);
    const record = data[key] as ConversationRecord | undefined;
    if (record) return record;

    // Legacy read-through migration: check the old global key.
    const oldKey = legacyConvKey(id);
    const oldData = await store().get(oldKey);
    const oldRecord = oldData[oldKey] as ConversationRecord | undefined;
    if (oldRecord) {
        // Migrate to the new scoped key and remove the legacy key.
        await store().set({ [key]: oldRecord });
        await addToIndex(convIndexKey(accountId), id);
        await store().remove(oldKey);
        return oldRecord;
    }
    return null;
}

/**
 * Record a completed turn for a conversation.
 * Creates the record if it doesn't exist, or appends the turn and updates aggregates.
 * The turns array is capped at MAX_TURNS_PER_RECORD; aggregate fields remain accurate.
 */
export async function recordTurn(
    accountId: string,
    conversationId: string,
    turn: Omit<TurnRecord, 'turnNumber'>,
    topicHint?: string,
): Promise<ConversationRecord> {
    const key = convKey(accountId, conversationId);
    const existing = await getConversation(accountId, conversationId);
    const now = turn.completedAt;

    if (existing) {
        const newTurnNumber = existing.turnCount + 1;
        const fullTurn: TurnRecord = { ...turn, turnNumber: newTurnNumber };

        // Cap the turns array. Drop oldest when at limit.
        const updatedTurns = [...existing.turns, fullTurn];
        if (updatedTurns.length > MAX_TURNS_PER_RECORD) {
            updatedTurns.shift();
        }

        const addedCost = turn.cost !== null ? turn.cost : 0;
        const prevCost = existing.estimatedCost;

        // Update DNA with the new topic hint (if provided and non-empty).
        const dna = { ...existing.dna };
        if (topicHint) {
            dna.lastContext = topicHint;
            dna.hints = [topicHint, ...dna.hints].slice(0, MAX_DNA_HINTS);
        }

        const updated: ConversationRecord = {
            ...existing,
            lastActiveAt: now,
            turnCount: newTurnNumber,
            totalInputTokens: existing.totalInputTokens + turn.inputTokens,
            totalOutputTokens: existing.totalOutputTokens + turn.outputTokens,
            peakContextPct: Math.max(existing.peakContextPct, turn.contextPct),
            lastContextPct: turn.contextPct,
            model: turn.model,
            estimatedCost: prevCost !== null || turn.cost !== null
                ? (prevCost ?? 0) + addedCost
                : null,
            turns: updatedTurns,
            dna,
        };

        await store().set({ [key]: updated });
        return updated;
    }

    // New conversation.
    const dna: ConversationDNA = {
        subject: topicHint ?? '',
        lastContext: topicHint ?? '',
        hints: topicHint ? [topicHint] : [],
    };

    const record: ConversationRecord = {
        id: conversationId,
        startedAt: now,
        lastActiveAt: now,
        finalized: false,
        turnCount: 1,
        totalInputTokens: turn.inputTokens,
        totalOutputTokens: turn.outputTokens,
        peakContextPct: turn.contextPct,
        lastContextPct: turn.contextPct,
        model: turn.model,
        estimatedCost: turn.cost,
        turns: [{ ...turn, turnNumber: 1 }],
        dna,
        _v: 1,
    };

    await store().set({ [key]: record });
    await addToIndex(convIndexKey(accountId), conversationId);
    return record;
}

/** Mark a conversation as finalized (user navigated away or tab closed). */
export async function finalizeConversation(accountId: string, id: string): Promise<void> {
    const record = await getConversation(accountId, id);
    if (!record || record.finalized) return;
    const key = convKey(accountId, id);
    await store().set({ [key]: { ...record, finalized: true } });
}

/**
 * List recent conversations. Returns at most `limit` records, newest first.
 * Offset supports pagination for the dashboard.
 */
export async function listConversations(
    accountId: string,
    limit: number,
    offset: number = 0,
): Promise<ConversationRecord[]> {
    let idxKey = convIndexKey(accountId);
    let index = await readIndex(idxKey);

    // Legacy fallback: if the account-scoped index is empty, read from the old
    // global index directly. We do NOT bulk-migrate here because legacy data
    // predates account isolation and we cannot know which account it belongs to.
    // Per-record migration happens in getConversation when each conversation is
    // individually accessed, at which point the correct accountId is known.
    if (index.length === 0) {
        const legacyIndex = await readIndex(LEGACY_CONV_INDEX_KEY);
        if (legacyIndex.length > 0) {
            const legacySlice = legacyIndex.slice(offset, offset + limit);
            if (legacySlice.length === 0) return [];
            const legacyKeys = legacySlice.map(legacyConvKey);
            const data = await store().get(legacyKeys);
            const results: ConversationRecord[] = [];
            for (const id of legacySlice) {
                const record = data[legacyConvKey(id)] as ConversationRecord | undefined;
                if (record) results.push(record);
            }
            return results;
        }
    }

    const slice = index.slice(offset, offset + limit);
    if (slice.length === 0) return [];

    const keys = slice.map((id) => convKey(accountId, id));
    const data = await store().get(keys);
    const results: ConversationRecord[] = [];
    for (const id of slice) {
        const record = data[convKey(accountId, id)] as ConversationRecord | undefined;
        if (record) results.push(record);
    }
    return results;
}

/**
 * Delete conversations older than the given timestamp.
 * Also cleans up the conversation index.
 * Returns the number of records deleted.
 */
export async function pruneConversations(accountId: string, beforeTimestamp: number): Promise<number> {
    const idxKey = convIndexKey(accountId);
    const index = await readIndex(idxKey);
    if (index.length === 0) return 0;

    const keys = index.map((id) => convKey(accountId, id));
    const data = await store().get(keys);

    const toDelete: string[] = [];
    const idsToRemove = new Set<string>();

    for (const id of index) {
        const record = data[convKey(accountId, id)] as ConversationRecord | undefined;
        if (!record || record.lastActiveAt < beforeTimestamp) {
            toDelete.push(convKey(accountId, id));
            idsToRemove.add(id);
        }
    }

    if (toDelete.length === 0) return 0;

    await store().remove(toDelete);
    await removeFromIndex(idxKey, idsToRemove);
    return toDelete.length;
}

// ── Daily summary ─────────────────────────────────────────────────────────────

/**
 * Compute (or recompute) the daily summary for a given date.
 * Scans all conversations for turns that fell on that date.
 */
export async function computeDailySummary(accountId: string, date: string): Promise<DailySummary> {
    const idxKey = convIndexKey(accountId);
    const index = await readIndex(idxKey);
    const keys = index.map((id) => convKey(accountId, id));
    const data = index.length > 0 ? await store().get(keys) : {};

    // Date boundaries in local time.
    const dayStart = new Date(date + 'T00:00:00').getTime();
    const dayEnd = dayStart + 86400000;

    let conversationCount = 0;
    let totalTurns = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost: number | null = null;
    let peakContextSum = 0;
    let criticalConversations = 0;
    const modelMap = new Map<string, { convs: Set<string>; input: number; output: number; cost: number | null }>();

    for (const id of index) {
        const record = data[convKey(accountId, id)] as ConversationRecord | undefined;
        if (!record) continue;

        // Filter turns that completed on this date.
        const dayTurns = record.turns.filter(
            (t) => t.completedAt >= dayStart && t.completedAt < dayEnd,
        );
        if (dayTurns.length === 0) continue;

        conversationCount++;
        totalTurns += dayTurns.length;

        for (const t of dayTurns) {
            totalInputTokens += t.inputTokens;
            totalOutputTokens += t.outputTokens;
            if (t.cost !== null) totalCost = (totalCost ?? 0) + t.cost;

            const entry = modelMap.get(t.model) ?? { convs: new Set(), input: 0, output: 0, cost: null };
            entry.convs.add(id);
            entry.input += t.inputTokens;
            entry.output += t.outputTokens;
            if (t.cost !== null) entry.cost = (entry.cost ?? 0) + t.cost;
            modelMap.set(t.model, entry);
        }

        peakContextSum += record.peakContextPct;
        if (record.peakContextPct >= CRITICAL_CONTEXT_PCT) criticalConversations++;
    }

    const modelBreakdown: ModelBreakdown[] = [];
    for (const [model, entry] of modelMap) {
        modelBreakdown.push({
            model,
            conversationCount: entry.convs.size,
            totalInputTokens: entry.input,
            totalOutputTokens: entry.output,
            estimatedCost: entry.cost,
        });
    }

    const summary: DailySummary = {
        date,
        conversationCount,
        totalTurns,
        totalInputTokens,
        totalOutputTokens,
        estimatedCost: totalCost,
        avgPeakContextPct: conversationCount > 0 ? peakContextSum / conversationCount : 0,
        criticalConversations,
        modelBreakdown,
        computedAt: Date.now(),
        _v: 1,
    };

    await store().set({ [dailyKey(accountId, date)]: summary });
    await addToIndex(dailyIndexKey(accountId), date);
    return summary;
}

/** Get a daily summary by date string. */
export async function getDailySummary(accountId: string, date: string): Promise<DailySummary | null> {
    const key = dailyKey(accountId, date);
    const data = await store().get(key);
    return (data[key] as DailySummary | undefined) ?? null;
}

/** List daily summaries for the last N days. */
export async function listDailySummaries(accountId: string, days: number): Promise<DailySummary[]> {
    const today = todayDateString();
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
        dates.push(dateStringForOffset(today, -i));
    }

    const keys = dates.map((d) => dailyKey(accountId, d));
    const data = await store().get(keys);

    const results: DailySummary[] = [];
    for (const d of dates) {
        const summary = data[dailyKey(accountId, d)] as DailySummary | undefined;
        if (summary) results.push(summary);
    }
    return results;
}

// ── Weekly summary ────────────────────────────────────────────────────────────

/** Compute (or recompute) the weekly summary for a given ISO week. */
export async function computeWeeklySummary(accountId: string, weekId: string): Promise<WeeklySummary> {
    const monday = weekMondayFromId(weekId);
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
        dates.push(dateStringForOffset(monday, i));
    }

    const keys = dates.map((d) => dailyKey(accountId, d));
    const data = await store().get(keys);

    let conversationCount = 0;
    let totalTurns = 0;
    let totalTokens = 0;
    let totalCost: number | null = null;
    let criticalConversations = 0;
    let heaviestDay = 0;
    let heaviestDayTokens = 0;
    const modelMap = new Map<string, { convCount: number; input: number; output: number; cost: number | null }>();

    for (let i = 0; i < dates.length; i++) {
        const summary = data[dailyKey(accountId, dates[i])] as DailySummary | undefined;
        if (!summary) continue;

        conversationCount += summary.conversationCount;
        totalTurns += summary.totalTurns;
        const dayTokens = summary.totalInputTokens + summary.totalOutputTokens;
        totalTokens += dayTokens;
        if (summary.estimatedCost !== null) totalCost = (totalCost ?? 0) + summary.estimatedCost;
        criticalConversations += summary.criticalConversations;

        if (dayTokens > heaviestDayTokens) {
            heaviestDayTokens = dayTokens;
            heaviestDay = i; // 0=Mon, 6=Sun
        }

        for (const mb of summary.modelBreakdown) {
            const entry = modelMap.get(mb.model) ?? { convCount: 0, input: 0, output: 0, cost: null };
            entry.convCount += mb.conversationCount;
            entry.input += mb.totalInputTokens;
            entry.output += mb.totalOutputTokens;
            if (mb.estimatedCost !== null) entry.cost = (entry.cost ?? 0) + mb.estimatedCost;
            modelMap.set(mb.model, entry);
        }
    }

    const modelBreakdown: ModelBreakdown[] = [];
    for (const [model, entry] of modelMap) {
        modelBreakdown.push({
            model,
            conversationCount: entry.convCount,
            totalInputTokens: entry.input,
            totalOutputTokens: entry.output,
            estimatedCost: entry.cost,
        });
    }

    const sunday = dateStringForOffset(monday, 6);

    const summary: WeeklySummary = {
        weekId,
        weekStart: monday,
        weekEnd: sunday,
        conversationCount,
        totalTurns,
        totalTokens,
        estimatedCost: totalCost,
        avgTurnsPerConversation: conversationCount > 0 ? totalTurns / conversationCount : 0,
        heaviestDay,
        modelBreakdown,
        criticalConversations,
        computedAt: Date.now(),
        _v: 1,
    };

    await store().set({ [weeklyKey(accountId, weekId)]: summary });
    await addToIndex(weeklyIndexKey(accountId), weekId);
    return summary;
}

/** Get a weekly summary by week ID. */
export async function getWeeklySummary(accountId: string, weekId: string): Promise<WeeklySummary | null> {
    const key = weeklyKey(accountId, weekId);
    const data = await store().get(key);
    return (data[key] as WeeklySummary | undefined) ?? null;
}

// ── Usage limits ──────────────────────────────────────────────────────────────
// Stores the latest Anthropic usage data per account.
// Source: /api/organizations/{orgId}/usage (fetched by content script).
// This is a single record per account, overwritten on each fetch.
// Unlike conversation records, there is no history or pruning: the latest
// data is all that matters for the dashboard display.

/**
 * Persist Anthropic usage limit data for an account.
 * Overwrites any previous record for this account.
 * Called by the background script STORE_USAGE_LIMITS handler.
 *
 * @param accountId - Organization UUID (scopes the key to one Claude account)
 * @param limits    - Parsed data from /api/organizations/{orgId}/usage
 */
export async function storeUsageLimits(accountId: string, limits: UsageLimitsData): Promise<void> {
    const key = usageLimitsKey(accountId);
    await store().set({ [key]: limits });
}

/**
 * Read the latest usage limit data for an account.
 * Returns null if no data has been stored yet (e.g. user has not loaded claude.ai
 * with the extension active since this feature shipped).
 *
 * Forward-compatible read shim: records written before tier dispatch (GET-20)
 * have no `kind` field. They are always the session shape (Pro/Personal was
 * the only tier we wrote to storage), so we tag them in-memory as 'session'
 * and return. Storage is left untouched; the next write overwrites with the
 * fully-tagged shape, and the legacy record never leaks back out.
 *
 * @param accountId - Organization UUID
 */
export async function getUsageLimits(accountId: string): Promise<UsageLimitsData | null> {
    const key = usageLimitsKey(accountId);
    const data = await store().get(key);
    const raw = data[key];
    if (!raw || typeof raw !== 'object') return null;

    const record = raw as Partial<UsageLimitsData> & {
        fiveHour?: unknown;
        sevenDay?: unknown;
    };

    // Already-tagged (session/credit/unsupported): return verbatim.
    if (record.kind === 'session' || record.kind === 'credit' || record.kind === 'unsupported') {
        return record as UsageLimitsData;
    }

    // Untagged legacy record: only the session shape was ever written. Detect
    // it by the two windows and re-emit as a session variant. Anything else
    // we cannot place gets dropped to null so downstream code does not have
    // to defend against half-typed records.
    if (record.fiveHour && record.sevenDay) {
        return { ...(record as Omit<UsageLimitsData, 'kind'>), kind: 'session' } as UsageLimitsData;
    }
    return null;
}

// ── Usage delta log ───────────────────────────────────────────────────────────
// Append-only array, one entry per completed turn where delta was measurable.
// Used by lib/token-economics.ts to derive median tokens-per-1% per model.
// Oldest entries are pruned when the cap is exceeded.

/**
 * Append one usage delta record to the per-account delta log.
 * Prunes the oldest entries when the log exceeds MAX_USAGE_DELTAS.
 *
 * @param accountId - Organization UUID (scopes the log to one Claude account)
 * @param delta     - Completed-turn delta record to append
 */
export async function appendUsageDelta(accountId: string, delta: UsageDelta): Promise<void> {
    const key = usageDeltasKey(accountId);
    const data = await store().get(key);
    const existing = data[key];
    const records: UsageDelta[] = Array.isArray(existing) ? existing as UsageDelta[] : [];

    records.push(delta);

    // Drop oldest entries when over the cap.
    const overflow = records.length - MAX_USAGE_DELTAS;
    if (overflow > 0) {
        records.splice(0, overflow);
    }

    await store().set({ [key]: records });
}

/**
 * Read all usage delta records for an account, oldest first.
 * Returns an empty array when no records exist.
 *
 * @param accountId - Organization UUID
 */
export async function getUsageDeltas(accountId: string): Promise<UsageDelta[]> {
    const key = usageDeltasKey(accountId);
    const data = await store().get(key);
    const records = data[key];
    return Array.isArray(records) ? records as UsageDelta[] : [];
}
