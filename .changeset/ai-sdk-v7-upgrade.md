---
"cognia-next": minor
---

Upgrade to Vercel AI SDK 7 (`ai` 7.0.48 and the matching `@ai-sdk/*` majors) across the app, the sidecar, the plugin SDK and the plugin scaffold template.

Token accounting changes: multi-step turns are now billed as the sum of every step rather than the final step alone, so reported usage for agentic sessions goes up — the previous figure under-reported real consumption. Cached and reasoning token counts now come from the canonical `inputTokenDetails` / `outputTokenDetails` objects, which v7 makes the only source.

Also in this release: MCP servers reached over HTTP/SSE no longer follow redirects (an SSRF guard that is now on by default) and report an actionable error instead; OpenTelemetry span collection moved to `@ai-sdk/otel` with the sidecar's no-endpoint-means-silent behaviour and its never-record-prompt-content policy both preserved; images sent to and returned from models use AI SDK 7's single canonical file part; and files a model references inside its reasoning trace arrive as a distinct part type that is deliberately dropped rather than rendered or persisted, matching the existing raw chain-of-thought policy.
