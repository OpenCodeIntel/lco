// tests/unit/sse-decoder.test.ts
// Unit tests for SSE stream parsing and provider event handling.
// Mirrors the pure logic from entrypoints/inject.ts so it can run in Node
// without a browser runtime. No changes to production code.

import { describe, it, expect, vi } from 'vitest';
import { ClaudeAdapter } from '../../lib/adapters/claude';

// -- Mirrored types --

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
  };
  body: {
    model: string;
    prompt: string;
  };
}

interface HealthState {
  chunksProcessed: number;
  sawMessageStart: boolean;
  sawContentBlock: boolean;
  stopReason: string | null;
}

// -- Mirrored helpers from inject.ts --

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPath(obj: any, dotPath: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dotPath.split('.').reduce((o: any, k: string) => o?.[k], obj);
}

/**
 * Parses a raw SSE buffer into an array of JSON event objects.
 * Mirrors the line-splitting and data-prefix-stripping logic in decodeSSEStream.
 * Returns parsed event objects; malformed JSON lines are silently skipped.
 */
function parseSseBuffer(buffer: string): unknown[] {
  const events: unknown[] = [];
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      events.push(JSON.parse(raw));
    } catch {
      // silently skip malformed JSON, matching inject.ts behavior
    }
  }
  return events;
}

/**
 * Mirrors handleProviderEvent from inject.ts.
 * Mutates health and summary in place, returns any utilization value emitted
 * (so tests can assert on MESSAGE_LIMIT_UPDATE without a postMessage mock).
 */
function handleProviderEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evt: any,
  config: InjectConfig,
  health: HealthState,
  summary: { inputTokens: number; outputTokens: number; model: string },
  promptText: string,
): { messageLimitUtilization?: number } {
  const { events, paths } = config;
  const type = evt.type;
  const result: { messageLimitUtilization?: number } = {};

  if (type === events.streamStart) {
    health.sawMessageStart = true;
    if (promptText) {
      summary.inputTokens = Math.round(promptText.length / 4);
    }
  }

  if (type === events.messageLimit) {
    const utilization = getPath(evt, paths.messageLimitUtilization);
    if (typeof utilization === 'number') {
      result.messageLimitUtilization = utilization;
    }
  }

  if (type === events.contentBlockStart) {
    health.sawContentBlock = true;
  }

  if (type === events.stopReason) {
    health.stopReason = getPath(evt, paths.stopReason) ?? null;
  }

  return result;
}

/**
 * Accumulates output token estimate from content_block_delta events.
 * Mirrors the accumulation block in decodeSSEStream.
 */
function accumulateOutputTokens(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evt: any,
  config: InjectConfig,
  outputTextBuffer: { text: string },
  summary: { outputTokens: number },
): void {
  if (evt.type !== config.events.contentDelta) return;
  const deltaType = getPath(evt, config.paths.contentDeltaType);
  const text = getPath(evt, config.paths.contentDeltaText);
  if (deltaType === config.paths.contentDeltaTypeValue && text) {
    outputTextBuffer.text += text;
    summary.outputTokens = Math.round(outputTextBuffer.text.length / 4);
  }
}

/**
 * Mirrors extractModelAndPromptFromInit from inject.ts.
 */
function extractModelAndPrompt(
  body: string | ArrayBuffer | null | undefined,
  config: InjectConfig,
): { model: string; prompt: string } {
  const result = { model: 'unknown', prompt: '' };
  if (!body) return result;
  try {
    const bodyStr =
      typeof body === 'string'
        ? body
        : body instanceof ArrayBuffer
          ? new TextDecoder().decode(body)
          : null;
    if (!bodyStr) return result;
    const parsed = JSON.parse(bodyStr);
    if (parsed[config.body.model]) result.model = parsed[config.body.model];
    if (parsed[config.body.prompt]) result.prompt = parsed[config.body.prompt];
  } catch {
    // malformed body returns defaults
  }
  return result;
}

/**
 * Mirrors isCompletionEndpoint from inject.ts.
 */
function isCompletionEndpoint(url: string, config: InjectConfig): boolean {
  const idx = url.indexOf(config.endpointSuffix);
  if (idx === -1) return false;
  const after = url[idx + config.endpointSuffix.length];
  const terminates = after === undefined || after === '?' || after === '#';
  return url.includes(config.endpointIncludes) && terminates;
}

// ---

const config = ClaudeAdapter.injectConfig;

function makeHealth(): HealthState {
  return { chunksProcessed: 0, sawMessageStart: false, sawContentBlock: false, stopReason: null };
}
function makeSummary(model = 'claude-sonnet-4-6') {
  return { inputTokens: 0, outputTokens: 0, model };
}

// ---

describe('SSE buffer parsing', () => {
  it('parses a single valid data line', () => {
    const buf = 'data: {"type":"message_start"}\n';
    const events = parseSseBuffer(buf);
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('message_start');
  });

  it('parses multiple data lines from one buffer', () => {
    const buf = [
      'data: {"type":"message_start"}',
      'data: {"type":"content_block_start"}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      '',
    ].join('\n');
    const events = parseSseBuffer(buf);
    expect(events).toHaveLength(3);
  });

  it('skips lines without data: prefix', () => {
    const buf = 'event: message\ndata: {"type":"message_start"}\nid: 1\n';
    const events = parseSseBuffer(buf);
    expect(events).toHaveLength(1);
  });

  it('skips the [DONE] sentinel', () => {
    const buf = 'data: {"type":"message_stop"}\ndata: [DONE]\n';
    const events = parseSseBuffer(buf);
    expect(events).toHaveLength(1);
  });

  it('skips empty data lines', () => {
    const buf = 'data: \ndata: {"type":"message_stop"}\n';
    const events = parseSseBuffer(buf);
    expect(events).toHaveLength(1);
  });

  it('silently skips malformed JSON and continues', () => {
    const buf = [
      'data: {"type":"message_start"}',
      'data: {broken json',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const events = parseSseBuffer(buf);
    expect(events).toHaveLength(2);
  });

  it('returns empty array for an empty buffer', () => {
    expect(parseSseBuffer('')).toHaveLength(0);
  });

  it('returns empty array when all lines are [DONE] or empty', () => {
    const buf = 'data: [DONE]\ndata: \n\n';
    expect(parseSseBuffer(buf)).toHaveLength(0);
  });

  it('handles trailing content without a newline (partial final chunk)', () => {
    // The buffer contains a complete event followed by an unterminated line.
    // parseSseBuffer splits on '\n', so only the complete line parses.
    const buf = 'data: {"type":"message_start"}\ndata: {"type":"co';
    const events = parseSseBuffer(buf);
    // Only the complete line parses; the partial line throws and is skipped.
    expect(events).toHaveLength(1);
  });
});

describe('handleProviderEvent — state mutations', () => {
  it('sets sawMessageStart on stream_start event', () => {
    const health = makeHealth();
    const summary = makeSummary();
    handleProviderEvent({ type: 'message_start' }, config, health, summary, '');
    expect(health.sawMessageStart).toBe(true);
  });

  it('computes chars/4 input estimate from promptText on stream_start', () => {
    const health = makeHealth();
    const summary = makeSummary();
    const prompt = 'a'.repeat(400); // 400 chars → 100 tokens
    handleProviderEvent({ type: 'message_start' }, config, health, summary, prompt);
    expect(summary.inputTokens).toBe(100);
  });

  it('does not update inputTokens when promptText is empty', () => {
    const health = makeHealth();
    const summary = makeSummary();
    handleProviderEvent({ type: 'message_start' }, config, health, summary, '');
    expect(summary.inputTokens).toBe(0);
  });

  it('sets sawContentBlock on content_block_start event', () => {
    const health = makeHealth();
    const summary = makeSummary();
    handleProviderEvent({ type: 'content_block_start' }, config, health, summary, '');
    expect(health.sawContentBlock).toBe(true);
  });

  it('extracts stop_reason from message_delta event', () => {
    const health = makeHealth();
    const summary = makeSummary();
    handleProviderEvent(
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      config,
      health,
      summary,
      '',
    );
    expect(health.stopReason).toBe('end_turn');
  });

  it('sets stopReason to null when stop_reason field is absent', () => {
    const health = makeHealth();
    const summary = makeSummary();
    handleProviderEvent({ type: 'message_delta', delta: {} }, config, health, summary, '');
    expect(health.stopReason).toBeNull();
  });

  it('extracts message_limit utilization value', () => {
    const health = makeHealth();
    const summary = makeSummary();
    const evt = {
      type: 'message_limit',
      message_limit: { windows: { overage: { utilization: 0.72 } } },
    };
    const result = handleProviderEvent(evt, config, health, summary, '');
    expect(result.messageLimitUtilization).toBe(0.72);
  });

  it('does not emit utilization when field is missing', () => {
    const health = makeHealth();
    const summary = makeSummary();
    const result = handleProviderEvent({ type: 'message_limit' }, config, health, summary, '');
    expect(result.messageLimitUtilization).toBeUndefined();
  });

  it('does not emit utilization when field is a string', () => {
    const health = makeHealth();
    const summary = makeSummary();
    const evt = {
      type: 'message_limit',
      message_limit: { windows: { overage: { utilization: 'high' } } },
    };
    const result = handleProviderEvent(evt, config, health, summary, '');
    expect(result.messageLimitUtilization).toBeUndefined();
  });

  it('ignores unrecognized event types without mutation', () => {
    const health = makeHealth();
    const summary = makeSummary();
    handleProviderEvent({ type: 'ping' }, config, health, summary, '');
    expect(health.sawMessageStart).toBe(false);
    expect(health.sawContentBlock).toBe(false);
    expect(health.stopReason).toBeNull();
    expect(summary.inputTokens).toBe(0);
  });
});

describe('output token accumulation', () => {
  it('accumulates text and estimates output tokens via chars/4', () => {
    const summary = makeSummary();
    const buf = { text: '' };
    const evt = {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'a'.repeat(200) },
    };
    accumulateOutputTokens(evt, config, buf, summary);
    expect(buf.text).toBe('a'.repeat(200));
    expect(summary.outputTokens).toBe(50); // 200 / 4
  });

  it('accumulates across multiple delta events', () => {
    const summary = makeSummary();
    const buf = { text: '' };
    for (let i = 0; i < 4; i++) {
      accumulateOutputTokens(
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a'.repeat(100) } },
        config,
        buf,
        summary,
      );
    }
    expect(buf.text.length).toBe(400);
    expect(summary.outputTokens).toBe(100);
  });

  it('ignores delta events with the wrong delta type', () => {
    const summary = makeSummary();
    const buf = { text: '' };
    accumulateOutputTokens(
      { type: 'content_block_delta', delta: { type: 'image_delta', data: 'abc' } },
      config,
      buf,
      summary,
    );
    expect(buf.text).toBe('');
    expect(summary.outputTokens).toBe(0);
  });

  it('ignores delta events with missing text field', () => {
    const summary = makeSummary();
    const buf = { text: '' };
    accumulateOutputTokens(
      { type: 'content_block_delta', delta: { type: 'text_delta' } },
      config,
      buf,
      summary,
    );
    expect(buf.text).toBe('');
    expect(summary.outputTokens).toBe(0);
  });

  it('does not mutate summary for non-delta event types', () => {
    const summary = makeSummary();
    const buf = { text: '' };
    accumulateOutputTokens({ type: 'message_start' }, config, buf, summary);
    expect(summary.outputTokens).toBe(0);
  });
});

describe('request body extraction', () => {
  it('extracts model and prompt from a JSON string body', () => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-6', prompt: 'Hello world' });
    const result = extractModelAndPrompt(body, config);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.prompt).toBe('Hello world');
  });

  it('extracts model and prompt from an ArrayBuffer body', () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ model: 'claude-opus-4-6', prompt: 'Test' }),
    ).buffer;
    const result = extractModelAndPrompt(body, config);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.prompt).toBe('Test');
  });

  it('returns defaults when body is null', () => {
    const result = extractModelAndPrompt(null, config);
    expect(result.model).toBe('unknown');
    expect(result.prompt).toBe('');
  });

  it('returns defaults when body is malformed JSON', () => {
    const result = extractModelAndPrompt('{not json', config);
    expect(result.model).toBe('unknown');
    expect(result.prompt).toBe('');
  });

  it('returns defaults when model field is absent', () => {
    const body = JSON.stringify({ prompt: 'Hello' });
    const result = extractModelAndPrompt(body, config);
    expect(result.model).toBe('unknown');
    expect(result.prompt).toBe('Hello');
  });

  it('returns defaults when prompt field is absent', () => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-6' });
    const result = extractModelAndPrompt(body, config);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.prompt).toBe('');
  });
});

describe('endpoint detection', () => {
  it('matches the Claude completion URL', () => {
    const url = 'https://claude.ai/api/organizations/abc/chat_conversations/uuid/completion';
    expect(isCompletionEndpoint(url, config)).toBe(true);
  });

  it('matches with a query string after the suffix', () => {
    const url = 'https://claude.ai/api/chat_conversations/uuid/completion?v=2';
    expect(isCompletionEndpoint(url, config)).toBe(true);
  });

  it('rejects a URL with additional path segments after the suffix', () => {
    const url = 'https://claude.ai/api/chat_conversations/uuid/completion/retry';
    expect(isCompletionEndpoint(url, config)).toBe(false);
  });

  it('rejects a non-completion Claude URL', () => {
    const url = 'https://claude.ai/api/chat_conversations/uuid/messages';
    expect(isCompletionEndpoint(url, config)).toBe(false);
  });

  it('rejects a URL missing the conversation pattern', () => {
    const url = 'https://claude.ai/api/completion';
    expect(isCompletionEndpoint(url, config)).toBe(false);
  });

  it('rejects an unrelated URL', () => {
    expect(isCompletionEndpoint('https://example.com/completion', config)).toBe(false);
  });
});

describe('getPath dot-path accessor', () => {
  it('resolves a shallow key', () => {
    expect(getPath({ type: 'test' }, 'type')).toBe('test');
  });

  it('resolves a nested key', () => {
    expect(getPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for a missing path', () => {
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });

  it('handles null intermediate values gracefully', () => {
    expect(getPath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('resolves the utilization path used by ClaudeAdapter', () => {
    const evt = { message_limit: { windows: { overage: { utilization: 0.48 } } } };
    expect(getPath(evt, config.paths.messageLimitUtilization)).toBe(0.48);
  });

  it('resolves the stop_reason path used by ClaudeAdapter', () => {
    const evt = { delta: { stop_reason: 'max_tokens' } };
    expect(getPath(evt, config.paths.stopReason)).toBe('max_tokens');
  });
});
