// entrypoints/inject.ts - Main world fetch interceptor and Claude SSE decoder (Room 1)
// Runs in the page's JavaScript context (Room 1).
// This script is entirely self-contained — no imports from lib/ to prevent
// chrome.* API references from bleeding into the unprivileged page context.
// WXT injects this as an unlisted script via injectScript() from the content script,
// passing the session token and platform via dataset attributes.

export default defineUnlistedScript(() => {
    (function () {
        // Provider Configuration (Inlined)
        const CLAUDE_COMPLETION_SUFFIX = '/completion';
        const CLAUDE_CONVERSATION_PATTERN = '/chat_conversations/';

        // LCO_V1 Bridge Security Constants (Inlined)
        // Session token and platform are injected by the content script at load time.
        const LCO_NAMESPACE = 'LCO_V1';
        const SESSION_TOKEN = document.currentScript?.dataset.sessionToken ?? '';
        const PLATFORM = document.currentScript?.dataset.platform ?? 'claude';

        // Capture the original fetch function before it is modified by platform wrappers
        const originalFetch = window.fetch;

        // Endpoint Detection
        function isCompletionEndpoint(url: string): boolean {
            // Use includes rather than endsWith so query-string variants (/completion?v=2) still match.
            const suffix = CLAUDE_COMPLETION_SUFFIX;
            const idx = url.indexOf(suffix);
            if (idx === -1) return false;
            const after = url[idx + suffix.length];
            const terminates = after === undefined || after === '?' || after === '#';
            return url.includes(CLAUDE_CONVERSATION_PATTERN) && terminates;
        }

        function isConversationGetEndpoint(url: string): boolean {
            return url.includes(CLAUDE_CONVERSATION_PATTERN) && url.includes('rendering_mode=messages');
        }

        // Secure Bridge: postMessage with LCO_V1 namespace + session token
        // Messages are batched every 200ms to avoid saturating the bridge.
        // Never uses '*' as targetOrigin — always scoped to the current origin.
        function postSecureBatch(payload: {
            type: 'TOKEN_BATCH' | 'STREAM_COMPLETE' | 'HEALTH_BROKEN' | 'MESSAGE_LIMIT_UPDATE';
            inputTokens?: number;
            outputTokens?: number;
            model?: string;
            stopReason?: string | null;
            message?: string;
            messageLimitUtilization?: number;
        }) {
            window.postMessage(
                {
                    namespace: LCO_NAMESPACE,
                    token: SESSION_TOKEN,
                    platform: PLATFORM,
                    ...payload,
                },
                window.location.origin,
            );
        }

        // Token Counting Bridge (internal, for BPE estimation via background worker)
        let _tokenIdCounter = 0;
        const _pendingTokenRequests = new Map<number, (count: number) => void>();

        window.addEventListener('message', (event) => {
            // Only accept responses from our own BPE counter bridge
            if (event.source !== window || !event.data || event.data.type !== 'LCO_TOKEN_RES') return;
            const { id, count } = event.data;
            const resolve = _pendingTokenRequests.get(id);
            if (resolve) {
                _pendingTokenRequests.delete(id);
                resolve(count);
            }
        });

        async function countTokens(text: string): Promise<number> {
            if (!text) return 0;
            return new Promise((resolve) => {
                const id = ++_tokenIdCounter;
                _pendingTokenRequests.set(id, resolve);
                window.postMessage({ type: 'LCO_TOKEN_REQ', id, text }, window.location.origin);

                // Fallback timeout to prevent memory leaks if the bridge is unavailable
                setTimeout(() => {
                    if (_pendingTokenRequests.has(id)) {
                        _pendingTokenRequests.delete(id);
                        resolve(0);
                    }
                }, 5000);
            });
        }

        // Claude SSE Event Handler
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
            promptText: string,
        ) {
            const type = evt.type;

            if (type === 'message_start') {
                health.sawMessageStart = true;
                // Use chars/4 as a fast synchronous estimate for real-time batch flushes.
                // Accurate BPE counts are computed once in the finally block.
                if (promptText) {
                    summary.inputTokens = Math.round(promptText.length / 4);
                }
                console.log(`[LCO] message_start : input: ~${summary.inputTokens} tokens (chars/4 estimate)`);
            }

            if (type === 'message_limit') {
                const utilization = evt.message_limit?.windows?.overage?.utilization;
                if (typeof utilization === 'number') {
                    console.log(`[LCO] message_limit : utilization: ${(utilization * 100).toFixed(1)}%`);
                    postSecureBatch({
                        type: 'MESSAGE_LIMIT_UPDATE',
                        messageLimitUtilization: utilization,
                    });
                }
            }

            if (type === 'content_block_start') {
                health.sawContentBlock = true;
            }

            if (type === 'message_delta') {
                health.stopReason = evt.delta?.stop_reason ?? null;
                console.log(`[LCO] message_delta : stop_reason: ${health.stopReason}`);
            }

            if (type === 'message_stop') {
                console.log('[LCO] message_stop : stream confirmed complete');
            }

            if (type === 'error') {
                console.error('[LCO-ERROR] Stream error event:', evt.error);
            }
        }

        // SSE Stream Decoder with 200ms Batch Flushing
        async function decodeSSEStream(
            stream: ReadableStream<Uint8Array>,
            requestModel: string,
            promptText: string,
        ) {
            const reader = stream.getReader();
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
                model: requestModel,
            };

            // Accumulates all output text synchronously; BPE counted once on stream end.
            let outputTextBuffer = '';

            let lastDataTime = Date.now();

            // 200ms batch flush timer — groups token data into single postMessage bursts
            let flushTimer: ReturnType<typeof setTimeout> | null = null;

            function scheduleBatchFlush() {
                if (flushTimer !== null) return; // already scheduled
                flushTimer = setTimeout(() => {
                    flushTimer = null;
                    postSecureBatch({
                        type: 'TOKEN_BATCH',
                        inputTokens: summary.inputTokens,
                        outputTokens: summary.outputTokens,
                        model: summary.model,
                    });
                }, 200);
            }

            // Watchdog interval to detect and close stalled connections
            const watchdog = setInterval(() => {
                if (Date.now() - lastDataTime > 120_000) {
                    clearInterval(watchdog);
                    reader.cancel();
                    console.error('[LCO-ERROR] Watchdog: stream silent for 120s - cancelled');
                }
            }, 10_000);

            try {
                while (true) {
                    let readResult;
                    try {
                        readResult = await reader.read();
                    } catch (err) {
                        if (err instanceof DOMException && err.name === 'AbortError') {
                            console.log('[LCO] Stream aborted by user via interface');
                        } else {
                            console.error('[LCO-ERROR] Stream read error:', err);
                        }
                        break;
                    }

                    const { done, value } = readResult;
                    if (done) break;

                    lastDataTime = Date.now();
                    buffer += decoder.decode(value, { stream: true });

                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';

                    for (const line of lines) {
                        if (!line.startsWith('data:')) continue;
                        const raw = line.slice(5).trim();
                        if (!raw || raw === '[DONE]') continue;

                        try {
                            const evt = JSON.parse(raw);
                            health.chunksProcessed++;
                            handleClaudeEvent(evt, health, summary, promptText);

                            // Accumulate output text synchronously; update estimate with chars/4.
                            if (evt.type === 'content_block_delta') {
                                const delta = evt.delta ?? {};
                                if (delta.type === 'text_delta' && delta.text) {
                                    outputTextBuffer += delta.text;
                                    summary.outputTokens = Math.round(outputTextBuffer.length / 4);
                                }
                            }

                            // Schedule a batch flush after processing each event with token data
                            if (evt.type === 'message_start' || evt.type === 'content_block_delta') {
                                scheduleBatchFlush();
                            }
                        } catch {
                            console.debug('[LCO] Skipped malformed JSON payload in SSE stream');
                        }
                    }
                }
            } finally {
                clearInterval(watchdog);

                // Flush the TextDecoder's internal state and process any line that was
                // not terminated by '\n' in the final chunk (rare but possible).
                buffer += decoder.decode(); // no {stream:true} → final flush
                if (buffer.trim()) {
                    for (const line of buffer.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        const raw = line.slice(5).trim();
                        if (!raw || raw === '[DONE]') continue;
                        try {
                            const evt = JSON.parse(raw);
                            health.chunksProcessed++;
                            handleClaudeEvent(evt, health, summary, promptText);
                            if (evt.type === 'content_block_delta') {
                                const delta = evt.delta ?? {};
                                if (delta.type === 'text_delta' && delta.text) {
                                    outputTextBuffer += delta.text;
                                }
                            }
                        } catch {
                            console.debug('[LCO] Skipped malformed JSON in final buffer flush');
                        }
                    }
                }

                // Cancel any pending flush and fire a final authoritative STREAM_COMPLETE
                if (flushTimer !== null) {
                    clearTimeout(flushTimer);
                    flushTimer = null;
                }

                reader.releaseLock();

                // Compute accurate BPE counts once on the full accumulated text.
                // Both calls run in parallel; fall back to the chars/4 estimate on failure.
                const [inputCount, outputCount] = await Promise.all([
                    countTokens(promptText),
                    countTokens(outputTextBuffer),
                ]);
                if (inputCount > 0) summary.inputTokens = inputCount;
                if (outputCount > 0) summary.outputTokens = outputCount;

                // Send final complete event to the content script bridge
                postSecureBatch({
                    type: 'STREAM_COMPLETE',
                    inputTokens: summary.inputTokens,
                    outputTokens: summary.outputTokens,
                    model: summary.model,
                    stopReason: health.stopReason,
                });

                console.log(
                    `%c[LCO] [Complete] model: ${summary.model}` +
                    (summary.inputTokens > 0 ? ` | ~${summary.inputTokens} in` : '') +
                    (summary.outputTokens > 0 ? ` | ~${summary.outputTokens} out` : '') +
                    (health.stopReason ? ` | stop: ${health.stopReason}` : ''),
                    'color: #4CAF50; font-weight: bold;',
                );

                if (!health.sawMessageStart && health.chunksProcessed >= 10) {
                    // Surface a health broken event so the UI can show a warning
                    postSecureBatch({
                        type: 'HEALTH_BROKEN',
                        message: `${health.chunksProcessed} chunks processed but missing Claude lifecycle events.`,
                    });
                    console.warn(
                        '[LCO-ERROR] Health check failed: ' +
                        `${health.chunksProcessed} chunks processed but missing Claude lifecycle events.`,
                    );
                }
            }
        }

        // Request Body Data Extraction
        function extractModelAndPromptFromInit(init?: RequestInit): { model: string; prompt: string } {
            const result = { model: 'unknown', prompt: '' };
            if (!init?.body) return result;
            try {
                const bodyStr =
                    typeof init.body === 'string'
                        ? init.body
                        : init.body instanceof ArrayBuffer
                            ? new TextDecoder().decode(init.body)
                            : null;
                if (!bodyStr) return result;
                const parsed = JSON.parse(bodyStr);
                if (parsed.model) result.model = parsed.model;
                if (parsed.prompt) result.prompt = parsed.prompt;
                return result;
            } catch {
                return result;
            }
        }

        // TODO(LCO-future): probeConversationResponse — inspect conversation GET
        // response shape when Anthropic adds token usage to the REST endpoint.
        // Currently the GET response contains no token/usage fields (verified March 2026).
        function probeConversationResponse(_response: Response): void { /* no-op */ }

        // Intercept API Requests
        const nativeFetch = originalFetch;
        window.fetch = async function (
            input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> {
            // Normalise all three overload shapes: string | URL | Request
            const url =
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                        ? input.href
                        : (input as Request)?.url ?? '';

            if (isCompletionEndpoint(url)) {
                const { model, prompt } = extractModelAndPromptFromInit(init);
                console.log(`[LCO] Intercepted completion request: ${url.slice(-80)} | model: ${model}`);

                const response = await nativeFetch.call(this, input, init);

                if (response.body) {
                    const [pageStream, monitorStream] = response.body.tee();
                    const cleanResponse = new Response(pageStream, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });

                    decodeSSEStream(monitorStream, model, prompt).catch((err) => {
                        console.error('[LCO-ERROR] SSE decoder failed:', err);
                    });

                    return cleanResponse;
                }

                return response;
            }

            if (isConversationGetEndpoint(url)) {
                const response = await nativeFetch.call(this, input, init);
                probeConversationResponse(response);
                return response;
            }

            return nativeFetch.call(this, input, init);
        };

        console.log('[LCO] Fetch interceptor initialized successfully.');
    })();
});
