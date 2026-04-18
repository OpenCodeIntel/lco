// entrypoints/inject.ts - Main world fetch interceptor and SSE decoder (Room 1)
// Runs in the page's JavaScript context (Room 1).
// Entirely self-contained: no imports from lib/ to prevent chrome.* API
// references from bleeding into the unprivileged page context.
// Injected via WXT injectScript() from the content script. Session token,
// platform, and provider config are passed via dataset attributes.

export default defineUnlistedScript(() => {
    (function () {
        // Provider config is serialized by the content script and passed via
        // dataset.injectConfig. All provider-specific strings live in
        // lib/adapters/claude.ts (or the relevant adapter) — not here.
        //
        // InjectConfig is defined inline to avoid importing from lib/.
        // The shape must stay in sync with lib/adapters/types.ts.
        interface InjectConfig {
            endpointIncludes: string;
            endpointSuffix: string;
            events: {
                streamStart: string;
                contentBlockStart: string;
                contentDelta: string;
                streamEnd: string;
                messageLimit: string;
                stopReason: string;
            };
            paths: {
                messageLimitUtilization: string;
                stopReason: string;
                contentDeltaType: string;
                contentDeltaTypeValue: string;
                contentDeltaText: string;
                // mirrors contextInputTokens in lib/adapters/types.ts
                contextInputTokens?: string;
            };
            body: {
                model: string;
                prompt: string;
            };
        }

        // LCO_V1 Bridge Security Constants (Inlined)
        // Session token, platform, and inject config are all set by the content
        // script at injection time via dataset attributes.
        const LCO_NAMESPACE = 'LCO_V1';
        const SESSION_TOKEN = document.currentScript?.dataset.sessionToken ?? '';
        const PLATFORM = document.currentScript?.dataset.platform ?? '';
        const INJECT_CONFIG: InjectConfig = JSON.parse(
            document.currentScript?.dataset.injectConfig ?? '{}',
        );

        // Capture the original fetch function before it is modified by platform wrappers
        const originalFetch = window.fetch;

        // Dot-path accessor used to extract values from SSE event objects.
        // Example: getPath(evt, 'delta.stop_reason') returns evt.delta?.stop_reason.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function getPath(obj: any, dotPath: string): any {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return dotPath.split('.').reduce((o: any, k: string) => o?.[k], obj);
        }

        // Organization ID extraction (inlined; inject.ts cannot import from lib/).
        // Mirrors extractOrganizationId in lib/conversation-store.ts.
        function extractOrgId(url: string): string | null {
            const m = url.match(/\/organizations\/([0-9a-f-]+)\//i);
            return m ? m[1].toLowerCase() : null;
        }

        // Endpoint Detection
        function isCompletionEndpoint(url: string): boolean {
            // Use indexOf rather than endsWith so query-string variants still match.
            const idx = url.indexOf(INJECT_CONFIG.endpointSuffix);
            if (idx === -1) return false;
            const after = url[idx + INJECT_CONFIG.endpointSuffix.length];
            const terminates = after === undefined || after === '?' || after === '#';
            return url.includes(INJECT_CONFIG.endpointIncludes) && terminates;
        }

        // Tracks whether the most recent stream ended with a health failure.
        // Persists across stream calls in this page load so HEALTH_RECOVERED
        // can be fired the next time a stream completes cleanly.
        let _lastStreamFailed = false;

        // Tracks whether we have already posted the ORGANIZATION_DETECTED message.
        // Fires once per page load on the first fetch to /api/organizations/.
        let _orgDetected = false;

        // Secure Bridge: postMessage with LCO_V1 namespace + session token
        // Messages are batched every 200ms to avoid saturating the bridge.
        // Never uses '*' as targetOrigin; always scoped to the current origin.
        function postSecureBatch(payload: {
            type: 'TOKEN_BATCH' | 'STREAM_COMPLETE' | 'HEALTH_BROKEN' | 'HEALTH_RECOVERED' | 'MESSAGE_LIMIT_UPDATE' | 'ORGANIZATION_DETECTED' | 'DRAFT_ESTIMATE';
            inputTokens?: number;
            outputTokens?: number;
            model?: string;
            stopReason?: string | null;
            reason?: string;
            message?: string;
            recoveredAt?: number;
            messageLimitUtilization?: number;
            topicHint?: string;
            promptLength?: number;
            hasCodeBlock?: boolean;
            isShortFollowUp?: boolean;
            organizationId?: string;
            draftCharCount?: number;
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

        // SSE Event Handler
        // HealthState is defined inline because inject.ts cannot import from lib/.
        interface HealthState {
            chunksProcessed: number;
            sawMessageStart: boolean;
            sawContentBlock: boolean;
            sawStreamEnd: boolean;
            stopReason: string | null;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function handleProviderEvent(
            evt: any,
            config: InjectConfig,
            health: HealthState,
            summary: { inputTokens: number; outputTokens: number; model: string; hasRealInputTokens: boolean },
            promptText: string,
        ) {
            const { events, paths } = config;
            const type = evt.type;

            if (type === events.streamStart) {
                health.sawMessageStart = true;

                // Prefer the exact input_tokens from the SSE stream over any estimate.
                // message_start carries message.usage.input_tokens, which equals the full
                // context Claude received: system prompt + entire conversation history +
                // current user message. This is the real context window consumption.
                // Fall back to chars/4 only when the field is absent (e.g. future providers).
                const realInputTokens = paths.contextInputTokens
                    ? getPath(evt, paths.contextInputTokens)
                    : undefined;

                if (typeof realInputTokens === 'number' && realInputTokens > 0) {
                    summary.inputTokens = realInputTokens;
                    summary.hasRealInputTokens = true;
                    console.log(`[LCO] ${events.streamStart} : input: ${realInputTokens} tokens (exact from SSE)`);
                } else {
                    summary.inputTokens = promptText ? Math.round(promptText.length / 4) : 0;
                    console.log(`[LCO] ${events.streamStart} : input: ~${summary.inputTokens} tokens (chars/4 estimate)`);
                }
            }

            if (type === events.messageLimit) {
                const utilization = getPath(evt, paths.messageLimitUtilization);
                if (typeof utilization === 'number') {
                    console.log(`[LCO] ${events.messageLimit} : utilization: ${(utilization * 100).toFixed(1)}%`);
                    postSecureBatch({
                        type: 'MESSAGE_LIMIT_UPDATE',
                        messageLimitUtilization: utilization,
                    });
                }
            }

            if (type === events.contentBlockStart) {
                health.sawContentBlock = true;
            }

            if (type === events.stopReason) {
                health.stopReason = getPath(evt, paths.stopReason) ?? null;
                console.log(`[LCO] ${events.stopReason} : stop_reason: ${health.stopReason}`);
            }

            if (type === events.streamEnd) {
                health.sawStreamEnd = true;
                console.log(`[LCO] ${events.streamEnd} : stream confirmed complete`);
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
            orgId: string | null,
        ) {
            const reader = stream.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            const health: HealthState = {
                chunksProcessed: 0,
                sawMessageStart: false,
                sawContentBlock: false,
                sawStreamEnd: false,
                stopReason: null,
            };

            // Guards against firing multiple HEALTH_BROKEN events for a single stream.
            let healthBrokenFired = false;

            const summary = {
                inputTokens: 0,
                outputTokens: 0,
                model: requestModel,
                // Set to true when message_start yields an exact input_tokens value from the
                // SSE stream. Guards the finally block from overwriting it with a chars/4 estimate.
                hasRealInputTokens: false,
            };

            // Accumulates all output text synchronously; BPE counted once on stream end.
            let outputTextBuffer = '';

            let lastDataTime = Date.now();

            // 200ms batch flush timer: groups token data into single postMessage bursts
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
                        ...(orgId ? { organizationId: orgId } : {}),
                    });
                }, 200);
            }

            // Watchdog interval to detect and close stalled connections
            const watchdog = setInterval(() => {
                if (Date.now() - lastDataTime > 120_000) {
                    clearInterval(watchdog);
                    if (!healthBrokenFired) {
                        healthBrokenFired = true;
                        postSecureBatch({
                            type: 'HEALTH_BROKEN',
                            reason: 'stream_timeout',
                            message: 'Stream silent for 120s - connection may be broken.',
                        });
                    }
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
                            handleProviderEvent(evt, INJECT_CONFIG, health, summary, promptText);

                            // Accumulate output text synchronously; update estimate with chars/4.
                            if (evt.type === INJECT_CONFIG.events.contentDelta) {
                                const deltaType = getPath(evt, INJECT_CONFIG.paths.contentDeltaType);
                                const text = getPath(evt, INJECT_CONFIG.paths.contentDeltaText);
                                if (deltaType === INJECT_CONFIG.paths.contentDeltaTypeValue && text) {
                                    outputTextBuffer += text;
                                    summary.outputTokens = Math.round(outputTextBuffer.length / 4);
                                }
                            }

                            // Schedule a batch flush after processing each event with token data
                            if (
                                evt.type === INJECT_CONFIG.events.streamStart ||
                                evt.type === INJECT_CONFIG.events.contentDelta
                            ) {
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
                buffer += decoder.decode(); // no {stream:true} -> final flush
                if (buffer.trim()) {
                    for (const line of buffer.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        const raw = line.slice(5).trim();
                        if (!raw || raw === '[DONE]') continue;
                        try {
                            const evt = JSON.parse(raw);
                            health.chunksProcessed++;
                            handleProviderEvent(evt, INJECT_CONFIG, health, summary, promptText);
                            if (evt.type === INJECT_CONFIG.events.contentDelta) {
                                const deltaType = getPath(evt, INJECT_CONFIG.paths.contentDeltaType);
                                const text = getPath(evt, INJECT_CONFIG.paths.contentDeltaText);
                                if (deltaType === INJECT_CONFIG.paths.contentDeltaTypeValue && text) {
                                    outputTextBuffer += text;
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
                // Input: skip if we already have the exact value from the SSE stream's
                // message_start event — that value is more accurate than counting only
                // the user's typed message, which misses conversation history tokens.
                // Output: always count from the accumulated buffer.
                const outputCount = await countTokens(outputTextBuffer);
                if (!summary.hasRealInputTokens) {
                    const inputCount = await countTokens(promptText);
                    if (inputCount > 0) summary.inputTokens = inputCount;
                }
                if (outputCount > 0) summary.outputTokens = outputCount;

                // Extract topic hint from the user's prompt for Conversation DNA.
                // Inlined here because inject.ts cannot import from lib/.
                const topicHint = (function extractHint(text: string): string {
                    if (!text) return '';
                    const MAX = 120;
                    const SKIP = /^(hey|hi|hello|thanks|thank you|ok|okay|sure|yes|no|great|awesome|perfect|cool|nice|got it|sounds good)\b/i;
                    const lines = text.split('\n');
                    let inCode = false;
                    for (const raw of lines) {
                        const ln = raw.trim();
                        if (ln.startsWith('```')) { inCode = !inCode; continue; }
                        if (inCode) continue;
                        if (ln.length < 10) continue;
                        if (SKIP.test(ln)) continue;
                        return ln.length > MAX ? ln.slice(0, MAX) + '...' : ln;
                    }
                    for (const raw of lines) {
                        const ln = raw.trim();
                        if (ln.length > 0 && !ln.startsWith('```')) return ln.length > MAX ? ln.slice(0, MAX) + '...' : ln;
                    }
                    return '';
                })(promptText);

                // Prompt characteristics for the Prompt Agent (inlined; inject.ts cannot import from lib/).
                // Thresholds here must stay in sync with lib/prompt-analysis.ts constants.
                const promptLength = promptText.length;
                const hasCodeBlock = promptText.includes('```');
                const isShortFollowUp = promptText.length > 0 && promptText.length < 50; // mirrors SHORT_FOLLOWUP_MAX_CHARS

                // Send final complete event to the content script bridge
                postSecureBatch({
                    type: 'STREAM_COMPLETE',
                    inputTokens: summary.inputTokens,
                    outputTokens: summary.outputTokens,
                    model: summary.model,
                    stopReason: health.stopReason,
                    topicHint,
                    promptLength,
                    hasCodeBlock,
                    isShortFollowUp,
                    ...(orgId ? { organizationId: orgId } : {}),
                });

                console.log(
                    `%c[LCO] [Complete] model: ${summary.model}` +
                    (summary.inputTokens > 0 ? ` | ~${summary.inputTokens} in` : '') +
                    (summary.outputTokens > 0 ? ` | ~${summary.outputTokens} out` : '') +
                    (health.stopReason ? ` | stop: ${health.stopReason}` : ''),
                    'color: #4CAF50; font-weight: bold;',
                );

                if (!healthBrokenFired) {
                    if (!health.sawMessageStart && health.chunksProcessed >= 10) {
                        healthBrokenFired = true;
                        postSecureBatch({
                            type: 'HEALTH_BROKEN',
                            reason: 'missing_sentinel',
                            message: `${health.chunksProcessed} chunks processed but stream_start event never arrived.`,
                        });
                        console.warn(
                            '[LCO-ERROR] Health check failed: ' +
                            `${health.chunksProcessed} chunks processed but stream_start event never arrived.`,
                        );
                    } else if (health.sawMessageStart && !health.sawStreamEnd) {
                        healthBrokenFired = true;
                        postSecureBatch({
                            type: 'HEALTH_BROKEN',
                            reason: 'incomplete_lifecycle',
                            message: 'Stream started but stream_end event never arrived.',
                        });
                        console.warn('[LCO-ERROR] Health check failed: stream started but stream_end event never arrived.');
                    }
                }

                if (healthBrokenFired) {
                    _lastStreamFailed = true;
                } else if (_lastStreamFailed) {
                    _lastStreamFailed = false;
                    postSecureBatch({
                        type: 'HEALTH_RECOVERED',
                        recoveredAt: Date.now(),
                    });
                    console.log('[LCO] Stream health recovered.');
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
                const modelField = INJECT_CONFIG.body.model;
                const promptField = INJECT_CONFIG.body.prompt;
                if (parsed[modelField]) result.model = parsed[modelField];
                if (parsed[promptField]) result.prompt = parsed[promptField];
                return result;
            } catch {
                return result;
            }
        }

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

            // Detect the org ID from any API call (not just completions).
            // Claude.ai makes dozens of fetches on page load (conversations list,
            // settings, etc.) that all go through /api/organizations/{orgId}/.
            // Posting ORGANIZATION_DETECTED immediately gives the content script
            // the account scope before the user sends their first message.
            if (!_orgDetected && url.includes('/api/organizations/')) {
                const earlyOrgId = extractOrgId(url);
                if (earlyOrgId) {
                    _orgDetected = true;
                    postSecureBatch({
                        type: 'ORGANIZATION_DETECTED',
                        organizationId: earlyOrgId,
                    });
                }
            }

            if (isCompletionEndpoint(url)) {
                const { model, prompt } = extractModelAndPromptFromInit(init);
                const organizationId = extractOrgId(url);
                console.log(`[LCO] Intercepted completion request: ${url.slice(-80)} | model: ${model}`);

                // Pre-send fallback: post the draft char count right before the
                // request fires. This guarantees the content script gets a cost
                // estimate even if the compose box DOM observer failed to attach
                // (e.g., claude.ai changed their DOM structure).
                if (prompt.length > 0) {
                    postSecureBatch({
                        type: 'DRAFT_ESTIMATE',
                        draftCharCount: prompt.length,
                    });
                }

                const response = await nativeFetch.call(this, input, init);

                if (response.body) {
                    const [pageStream, monitorStream] = response.body.tee();
                    const cleanResponse = new Response(pageStream, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });

                    decodeSSEStream(monitorStream, model, prompt, organizationId).catch((err) => {
                        console.error('[LCO-ERROR] SSE decoder failed:', err);
                    });

                    return cleanResponse;
                }

                return response;
            }

            return nativeFetch.call(this, input, init);
        };

        console.log('[LCO] Fetch interceptor initialized successfully.');
    })();
});
