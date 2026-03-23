// entrypoints/inject.ts — MAIN world fetch interceptor + Claude SSE decoder
// Runs in the page's JavaScript context (Room 1).
// COMPLETELY SELF-CONTAINED — no imports from lib/ to avoid chrome.* contamination.
// WXT injects this as an unlisted script via injectScript() from the content script.

export default defineUnlistedScript(() => {
    (function () {
        // ─── INLINED PROVIDER CONFIG ────────────────────────────────────────────────
        // Source of truth is lib/platform-config.ts — kept in sync manually.
        // Inlined to guarantee zero transitive chrome.* references in MAIN world.
        // VERIFIED: Claude streams via /api/organizations/{uuid}/chat_conversations/{uuid}/completion
        // '/chat_conversations/' is specific enough — won't match analytics or auth calls
        const CLAUDE_ENDPOINTS = ['/chat_conversations/'];
        // ─── CAPTURE PLATFORM FETCH WRAPPER ─────────────────────────────────────────
        // On both claude.ai and chat.openai.com, fetch is already monkey-patched
        // by DataDog/Intercom instrumentation. We save THEIR wrapper as originalFetch.
        // Chain: our wrapper → their wrapper → native fetch.
        const originalFetch = window.fetch;

        // ─── ENDPOINT DETECTION ─────────────────────────────────────────────────────
        function isClaudeEndpoint(url: string): boolean {
            return CLAUDE_ENDPOINTS.some((ep) => url.includes(ep));
        }

        // ─── CLAUDE SSE EVENT HANDLER ───────────────────────────────────────────────
        interface HealthState {
            chunksProcessed: number;
            sawMessageStart: boolean;
            sawContentBlock: boolean;
            stopReason: string | null;
        }

        function handleClaudeEvent(
            evt: any,
            health: HealthState,
            summary: { inputTokens: number; outputTokens: number; model: string },
        ) {
            const type = evt.type;

            // message_start: input tokens + cache tokens (exact from Anthropic)
            if (type === 'message_start') {
                health.sawMessageStart = true;
                const usage = evt.message?.usage ?? {};
                const inputTokens = usage.input_tokens ?? 0;
                const cacheCreate = usage.cache_creation_input_tokens ?? 0;
                const cacheRead = usage.cache_read_input_tokens ?? 0;
                const model = evt.message?.model ?? 'unknown';

                summary.inputTokens = inputTokens;
                summary.model = model;

                console.log(
                    `[LCO] message_start → input: ${inputTokens} tokens, ` +
                    `cache_create: ${cacheCreate}, cache_read: ${cacheRead}, ` +
                    `model: ${model}`,
                );
            }

            // content_block_start: note block type
            if (type === 'content_block_start') {
                health.sawContentBlock = true;
            }

            // content_block_delta: visible text OR partial tool JSON
            if (type === 'content_block_delta') {
                const delta = evt.delta ?? {};
                if (delta.type === 'text_delta' && delta.text) {
                    // Log first 80 chars of text deltas to avoid flooding console
                    const preview = delta.text.length > 80 ? delta.text.slice(0, 80) + '…' : delta.text;
                    console.log(`[LCO] text_delta → "${preview}"`);
                }
            }

            // message_delta: final output token count (exact from Anthropic)
            if (type === 'message_delta') {
                health.stopReason = evt.delta?.stop_reason ?? null;
                const outputTokens = evt.usage?.output_tokens ?? 0;
                summary.outputTokens = outputTokens;

                console.log(
                    `[LCO] message_delta → output: ${outputTokens} tokens, ` +
                    `stop_reason: ${health.stopReason}`,
                );
            }

            // message_stop: stream complete confirmation
            if (type === 'message_stop') {
                console.log('[LCO] message_stop → stream confirmed complete');
            }

            // Error injected into stream — treat as termination
            if (type === 'error') {
                console.error('[LCO-ERROR] Stream error event:', evt.error);
            }
        }

        // ─── SSE STREAM DECODER ─────────────────────────────────────────────────────
        async function decodeSSEStream(stream: ReadableStream<Uint8Array>) {
            const reader = stream.getReader();
            // MANDATORY: stream: true — without it, multi-byte UTF-8 chars split
            // across chunk boundaries produce corrupted replacement characters.
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            const health: HealthState = {
                chunksProcessed: 0,
                sawMessageStart: false,
                sawContentBlock: false,
                stopReason: null,
            };

            const summary = {
                inputTokens: 0,
                outputTokens: 0,
                model: 'unknown',
            };

            let lastDataTime = Date.now();

            // Watchdog — handles silent stalls and missing message_stop
            const watchdog = setInterval(() => {
                if (Date.now() - lastDataTime > 120_000) {
                    // 2 min silence = dead stream
                    clearInterval(watchdog);
                    reader.cancel();
                    console.error('[LCO-ERROR] Watchdog: stream silent for 120s — cancelled');
                }
            }, 10_000); // check every 10 seconds

            try {
                while (true) {
                    let readResult;
                    try {
                        readResult = await reader.read();
                    } catch (err) {
                        // Handle user clicking Claude's stop button:
                        // Page branch gets cancelled → backpressure aborts our branch
                        if (err instanceof DOMException && err.name === 'AbortError') {
                            console.log('[LCO] Stream aborted by user (stop button)');
                        } else {
                            console.error('[LCO-ERROR] Stream read error:', err);
                        }
                        break;
                    }

                    const { done, value } = readResult;
                    if (done) break;

                    lastDataTime = Date.now();
                    buffer += decoder.decode(value, { stream: true });

                    // Split on newlines — SSE uses \n\n between events
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? ''; // keep incomplete last line in buffer

                    for (const line of lines) {
                        // Handle both "data: {...}" and "data:{...}" (RFC violation in the wild)
                        if (!line.startsWith('data:')) continue;
                        const raw = line.slice(5).trim();
                        if (!raw || raw === '[DONE]') continue;

                        try {
                            const evt = JSON.parse(raw);
                            health.chunksProcessed++;
                            handleClaudeEvent(evt, health, summary);
                        } catch {
                            // Malformed JSON — skip but log at debug level
                            console.debug('[LCO] Skipped malformed JSON in SSE line');
                        }
                    }
                }
            } finally {
                clearInterval(watchdog);
                reader.releaseLock();

                // ─── STREAM COMPLETE SUMMARY ──────────────────────────────────────────
                console.log(
                    `%c[LCO] ✓ Stream complete → ${summary.inputTokens} in / ${summary.outputTokens} out` +
                    ` | model: ${summary.model}` +
                    (health.stopReason ? ` | stop: ${health.stopReason}` : ''),
                    'color: #4CAF50; font-weight: bold;',
                );

                // Health evaluation
                if (!health.sawMessageStart && health.chunksProcessed >= 10) {
                    console.warn(
                        '[LCO-ERROR] Health check: BROKEN — ' +
                        `${health.chunksProcessed} chunks processed but no Claude lifecycle events detected. ` +
                        'The SSE format may have changed.',
                    );
                }
            }
        }

        // ─── FETCH INTERCEPTOR ──────────────────────────────────────────────────────
        const nativeFetch = originalFetch; // alias for clarity in apply calls
        window.fetch = async function (
            input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> {
            const url = typeof input === 'string' ? input : (input as Request)?.url ?? '';

            // Not a Claude endpoint — pass straight through
            if (!isClaudeEndpoint(url)) {
                return nativeFetch.call(this, input, init);
            }

            console.log(`[LCO] Intercepted fetch: ${url}`);

            // Call real fetch — do NOT await monitoring before returning
            const response = await nativeFetch.call(this, input, init);

            if (response.body) {
                // Split stream — Branch 1 to page, Branch 2 to us
                const [pageStream, monitorStream] = response.body.tee();

                // Build clean response for the page with Branch 1
                const cleanResponse = new Response(pageStream, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });

                // Fire-and-forget — never block the page
                decodeSSEStream(monitorStream).catch((err) => {
                    console.error('[LCO-ERROR] SSE decoder failed:', err);
                });

                return cleanResponse;
            }

            return response;
        };

        console.log('[LCO] Fetch interceptor installed — watching for Claude API calls');
    })();
});
