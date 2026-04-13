// e2e/mock-server.ts
// HTTPS server that impersonates claude.ai for E2E testing.
// Serves pages at paths the extension expects and streams SSE in Claude's exact format.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3456;
const CERT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'certs');

const cert = fs.readFileSync(path.join(CERT_DIR, 'cert.pem'));
const key = fs.readFileSync(path.join(CERT_DIR, 'key.pem'));

// SSE event builders: match Claude's exact wire format as parsed by inject.ts
function sseEvent(data: object): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

function buildNormalStream(deltas: number = 10): string[] {
    const events: string[] = [];

    // message_start
    events.push(sseEvent({ type: 'message_start', message: { id: 'msg_test', model: 'claude-sonnet-4-6' } }));

    // content_block_start
    events.push(sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));

    // N content_block_delta events
    for (let i = 0; i < deltas; i++) {
        events.push(sseEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `Word${i} ` },
        }));
    }

    // content_block_stop
    events.push(sseEvent({ type: 'content_block_stop', index: 0 }));

    // message_delta with stop_reason
    events.push(sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: deltas * 2 } }));

    // message_stop
    events.push(sseEvent({ type: 'message_stop' }));

    return events;
}

function buildMessageLimitStream(): string[] {
    const events = buildNormalStream(5);
    // Insert a message_limit event after the first delta
    const limitEvent = sseEvent({
        type: 'message_limit',
        message_limit: {
            windows: {
                overage: { utilization: 0.42 },
            },
        },
    });
    events.splice(3, 0, limitEvent);
    return events;
}

function buildMalformedStream(): string[] {
    const events: string[] = [];
    events.push(sseEvent({ type: 'message_start', message: { id: 'msg_bad', model: 'claude-sonnet-4-6' } }));
    events.push(sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    events.push(sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }));
    // Malformed JSON mid-stream
    events.push('data: {broken json\n\n');
    events.push(sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } }));
    events.push(sseEvent({ type: 'content_block_stop', index: 0 }));
    events.push(sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }));
    events.push(sseEvent({ type: 'message_stop' }));
    return events;
}

// HTML page that mimics minimal claude.ai structure.
// Includes a script to trigger fetch to the SSE endpoint.
const TEST_PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>Claude (Mock)</title></head>
<body>
<div id="test-root">
  <h1>Claude Mock for E2E Testing</h1>
  <div class="ProseMirror" contenteditable="true" data-placeholder="Message Claude..."></div>
  <button id="trigger-stream" onclick="triggerStream()">Send</button>
  <button id="trigger-stream-long" onclick="triggerStream('long')">Send Long</button>
  <button id="trigger-stream-malformed" onclick="triggerStream('malformed')">Send Malformed</button>
  <button id="trigger-stream-limit" onclick="triggerStream('limit')">Send With Limit</button>
  <pre id="log"></pre>
</div>
<script>
  // Conversation UUID for the endpoint path
  const CONV_ID = '550e8400-e29b-41d4-a716-446655440000';

  function log(msg) {
    const el = document.getElementById('log');
    if (el) el.textContent += msg + '\\n';
  }

  async function triggerStream(scenario) {
    const query = scenario ? '?scenario=' + scenario : '';
    const url = '/api/organizations/org-test-123/chat_conversations/' + CONV_ID + '/completion' + query;
    log('Fetching: ' + url);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          prompt: 'Explain how context windows work in large language models and why they matter for conversation quality.',
        }),
      });
      log('Status: ' + resp.status);
      if (!resp.ok) {
        log('Error response: ' + resp.status);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let chunks = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks++;
        const text = decoder.decode(value, { stream: true });
        // Count data lines
        const dataLines = text.split('\\n').filter(l => l.startsWith('data:')).length;
        log('Chunk ' + chunks + ': ' + dataLines + ' events');
      }
      log('Stream complete. Total chunks: ' + chunks);
    } catch (err) {
      log('Fetch error: ' + err.message);
    }
  }
</script>
</body>
</html>`;

const server = https.createServer({ cert, key }, (req, res) => {
    const url = new URL(req.url ?? '/', `https://${req.headers.host}`);
    const pathname = url.pathname;

    // Usage endpoint mock (returns minimal data for fetchAndStoreUsageLimits)
    if (pathname.match(/^\/api\/organizations\/[^/]+\/usage$/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            five_hour: { utilization: 0.15, resets_at: new Date(Date.now() + 3600000).toISOString() },
            seven_day: { utilization: 0.08, resets_at: new Date(Date.now() + 86400000 * 3).toISOString() },
        }));
        return;
    }

    // SSE completion endpoint
    if (pathname.includes('/chat_conversations/') && pathname.endsWith('/completion')) {
        const scenario = url.searchParams.get('scenario') ?? 'normal';

        if (scenario === 'error') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }

        if (scenario === 'ratelimit') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Rate limited' }));
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        let events: string[];
        switch (scenario) {
            case 'long':
                events = buildNormalStream(1000);
                break;
            case 'malformed':
                events = buildMalformedStream();
                break;
            case 'limit':
                events = buildMessageLimitStream();
                break;
            default:
                events = buildNormalStream(10);
        }

        // Stream events with small delays to simulate real SSE
        let i = 0;
        const interval = setInterval(() => {
            if (i >= events.length) {
                clearInterval(interval);
                res.end();
                return;
            }
            res.write(events[i]);
            i++;
        }, 5); // 5ms between events for speed; real streams are slower

        req.on('close', () => clearInterval(interval));
        return;
    }

    // Serve the test page at various paths the extension might encounter
    if (pathname === '/' || pathname.startsWith('/chat/') || pathname === '/new') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(TEST_PAGE_HTML);
        return;
    }

    // 404 for anything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mock claude.ai server running on https://0.0.0.0:${PORT}`);
});
