// lib/conversation-store.ts
// Persistent conversation storage against chrome.storage.local.
// Stores metadata only (tokens, model, cost, timestamps). Never stores conversation text.
// All functions accept an optional storage parameter for testability.

import { calculateCost } from './pricing';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface TurnRecord {
    turnNumber: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
    contextPct: number;
    cost: number | null;
    completedAt: number;
}

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

// Storage key prefixes and index names.
const CONV_PREFIX = 'conv:';
const DAILY_PREFIX = 'daily:';
const WEEKLY_PREFIX = 'weekly:';
const CONV_INDEX_KEY = 'convIndex';
const DAILY_INDEX_KEY = 'dailyIndex';
const WEEKLY_INDEX_KEY = 'weeklyIndex';

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

/** Get a single conversation by UUID. Returns null if not found. */
export async function getConversation(id: string): Promise<ConversationRecord | null> {
    const key = CONV_PREFIX + id;
    const data = await store().get(key);
    return (data[key] as ConversationRecord | undefined) ?? null;
}

/**
 * Record a completed turn for a conversation.
 * Creates the record if it doesn't exist, or appends the turn and updates aggregates.
 * The turns array is capped at MAX_TURNS_PER_RECORD; aggregate fields remain accurate.
 */
export async function recordTurn(
    conversationId: string,
    turn: Omit<TurnRecord, 'turnNumber'>,
): Promise<ConversationRecord> {
    const key = CONV_PREFIX + conversationId;
    const existing = await getConversation(conversationId);
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
        };

        await store().set({ [key]: updated });
        return updated;
    }

    // New conversation.
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
        _v: 1,
    };

    await store().set({ [key]: record });
    await addToIndex(CONV_INDEX_KEY, conversationId);
    return record;
}

/** Mark a conversation as finalized (user navigated away or tab closed). */
export async function finalizeConversation(id: string): Promise<void> {
    const record = await getConversation(id);
    if (!record || record.finalized) return;
    const key = CONV_PREFIX + id;
    await store().set({ [key]: { ...record, finalized: true } });
}

/**
 * List recent conversations. Returns at most `limit` records, newest first.
 * Offset supports pagination for the dashboard.
 */
export async function listConversations(
    limit: number,
    offset: number = 0,
): Promise<ConversationRecord[]> {
    const index = await readIndex(CONV_INDEX_KEY);
    const slice = index.slice(offset, offset + limit);
    if (slice.length === 0) return [];

    const keys = slice.map((id) => CONV_PREFIX + id);
    const data = await store().get(keys);
    const results: ConversationRecord[] = [];
    for (const id of slice) {
        const record = data[CONV_PREFIX + id] as ConversationRecord | undefined;
        if (record) results.push(record);
    }
    return results;
}

/**
 * Delete conversations older than the given timestamp.
 * Also cleans up the conversation index.
 * Returns the number of records deleted.
 */
export async function pruneConversations(beforeTimestamp: number): Promise<number> {
    const index = await readIndex(CONV_INDEX_KEY);
    if (index.length === 0) return 0;

    // Batch-read all conversation records.
    const keys = index.map((id) => CONV_PREFIX + id);
    const data = await store().get(keys);

    const toDelete: string[] = [];
    const idsToRemove = new Set<string>();

    for (const id of index) {
        const record = data[CONV_PREFIX + id] as ConversationRecord | undefined;
        if (!record || record.lastActiveAt < beforeTimestamp) {
            toDelete.push(CONV_PREFIX + id);
            idsToRemove.add(id);
        }
    }

    if (toDelete.length === 0) return 0;

    await store().remove(toDelete);
    await removeFromIndex(CONV_INDEX_KEY, idsToRemove);
    return toDelete.length;
}

// ── Daily summary ─────────────────────────────────────────────────────────────

/**
 * Compute (or recompute) the daily summary for a given date.
 * Scans all conversations for turns that fell on that date.
 */
export async function computeDailySummary(date: string): Promise<DailySummary> {
    const index = await readIndex(CONV_INDEX_KEY);
    const keys = index.map((id) => CONV_PREFIX + id);
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
        const record = data[CONV_PREFIX + id] as ConversationRecord | undefined;
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

    await store().set({ [DAILY_PREFIX + date]: summary });
    await addToIndex(DAILY_INDEX_KEY, date);
    return summary;
}

/** Get a daily summary by date string. */
export async function getDailySummary(date: string): Promise<DailySummary | null> {
    const key = DAILY_PREFIX + date;
    const data = await store().get(key);
    return (data[key] as DailySummary | undefined) ?? null;
}

/** List daily summaries for the last N days. */
export async function listDailySummaries(days: number): Promise<DailySummary[]> {
    const today = todayDateString();
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
        dates.push(dateStringForOffset(today, -i));
    }

    const keys = dates.map((d) => DAILY_PREFIX + d);
    const data = await store().get(keys);

    const results: DailySummary[] = [];
    for (const d of dates) {
        const summary = data[DAILY_PREFIX + d] as DailySummary | undefined;
        if (summary) results.push(summary);
    }
    return results;
}

// ── Weekly summary ────────────────────────────────────────────────────────────

/** Compute (or recompute) the weekly summary for a given ISO week. */
export async function computeWeeklySummary(weekId: string): Promise<WeeklySummary> {
    const monday = weekMondayFromId(weekId);
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
        dates.push(dateStringForOffset(monday, i));
    }

    const keys = dates.map((d) => DAILY_PREFIX + d);
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
        const summary = data[DAILY_PREFIX + dates[i]] as DailySummary | undefined;
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

    await store().set({ [WEEKLY_PREFIX + weekId]: summary });
    await addToIndex(WEEKLY_INDEX_KEY, weekId);
    return summary;
}

/** Get a weekly summary by week ID. */
export async function getWeeklySummary(weekId: string): Promise<WeeklySummary | null> {
    const key = WEEKLY_PREFIX + weekId;
    const data = await store().get(key);
    return (data[key] as WeeklySummary | undefined) ?? null;
}
