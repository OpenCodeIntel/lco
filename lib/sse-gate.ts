// lib/sse-gate.ts
// Canonical predicate for the inject-time SSE gate. Decides whether the
// fetch interceptor in entrypoints/inject.ts should tee + decode a
// completion response, or hand it back to claude.ai unmodified.
//
// inject.ts cannot import this module — it runs in MAIN world and the
// no-lib-imports rule keeps chrome.* references from bleeding into the
// unprivileged page context. The gate is therefore mirrored inline in
// inject.ts. tests/unit/inject-non-sse.test.ts contains a fingerprint
// guard that asserts the inline copy still matches the substrings below;
// when you change anything here, update the inject.ts mirror in the same
// commit and the guard test will tell you if you forgot.
//
// Behaviour:
//   - Status must be exactly 200. Anthropic's stream endpoint returns
//     429 / 5xx / captcha-HTML through the same URL; feeding non-stream
//     bytes into the SSE decoder silently fails until the watchdog fires.
//   - Content-Type must START WITH 'text/event-stream'. A plain substring
//     match would accept hostile or malformed types like
//     'application/x-no-event-stream'. We compare in lowercase because
//     HTTP header VALUES are not normalized by the Headers API (only
//     names are), so 'TEXT/EVENT-STREAM' is a legal SSE response.
//   - Body must be present. tee() throws on a null ReadableStream.

export function shouldTeeAndDecode(
    status: number,
    contentType: string,
    hasBody: boolean,
): boolean {
    if (!hasBody) return false;
    if (status !== 200) return false;
    return contentType.toLowerCase().startsWith('text/event-stream');
}
