# Browser Companion v2 — implementation plan (ADR-0228)

Gap analysis inputs: 2026-10-16 competitor research (ChatGPT extension 1.26,
Claude in Chrome 1.0.100, Gemini in Chrome, Copilot in Edge, Perplexity,
Monica, Sider, MaxAI, Merlin, Glasp, Readwise, Notion, Raindrop, Obsidian
Web Clipper) and two host audits (companion API map, browser engine stack).

Every WP ships its co-located tests, en + zh_CN extension locale keys
(`browser-extension/public/_locales`, `locale-coverage.test.ts`) and, for app
UI, `i18n/messages/{en,zh-CN}` split sources + `pnpm i18n:build`.

## WP0 — Defects (no new surface)

| #   | Defect                                                                                                                                                          | Fix                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 0.1 | `/api/_rpc/browser_context_submit` refused above 64 KiB (`crates/cognia-companion/src/server.rs` `limit_public_request_body`) while the contract allows 192 KiB | per-route ceiling = `BROWSER_SUBMIT_BODY_LIMIT_BYTES` (mirrors `limits.requestBytes`), test with/without content-length |
| 0.2 | `suggestedTitle` never sent                                                                                                                                     | editable title field in the preview                                                                                     |
| 0.3 | list never pages (`nextPageToken` never issued, extension asks 20)                                                                                              | Host issues an opaque page token; panel "load more" + search                                                            |
| 0.4 | problem document `retryable` / `retryAfterSeconds` ignored                                                                                                      | panel uses `companionErrorCode` / `problemRetryAfterMs`; automatic retry for retryable submit failures                  |
| 0.5 | template-rendered instruction not byte-capped                                                                                                                   | cap with `instructionBytes`, refuse `too_large`                                                                         |
| 0.6 | `submit` answers `submission_owned_elsewhere`, `get` answers `submission_not_found`                                                                             | both answer `submission_not_found`                                                                                      |
| 0.7 | `apply-appearance` writes any property name                                                                                                                     | only `--` custom properties from the token catalogue shape (`^--[a-z0-9-]+$`)                                           |

## WP1 — Capture v2 (contract additive, extension + Host prompt)

- Contract (`packages/companion-client/src/browser-companion.ts`):
  `BrowserCaptureMode += "article"`; `BrowserPageContextV1` optional
  `selectionMarkdown?`, `article?: { markdown, truncated, originalCharacterCount }`,
  `metadata?: { byline, publishedAt, siteName, lang, description, canonicalUrl }`,
  `transcript?: { text, truncated, language, source: "captions", segments? } | { unavailable: reason }`,
  `link?: { url, text }`, `image?: { url, alt }`;
  `capability.features?: BrowserCompanionFeature[]`.
- Extractor (`browser-extension/src/lib/capture/`): `extract-article.ts`
  (readability scoring + DOM→Markdown, self-contained for `executeScript`),
  `extract-metadata.ts`, `extract-transcript.ts` (YouTube `ytInitialPlayerResponse`
  caption track → timedtext JSON3, main world read), selection→Markdown.
- Host: `limits.ts` validates the new fields; `build-prompt.ts` renders them
  inside the fence; capability lists features.
- Entry points: context menus link / image / quick-action submenu; commands
  `_execute_action`, `capture-page`, `capture-selection`, `capture-article`;
  omnibox keyword `cog`; Ctrl/⌘+Enter.
- Panel: quick actions (summarize / explain / translate / key points /
  simplify), saved prompt library (`chrome.storage.local`, no content), title
  and text editing, stale-capture hint (tab switched / navigated via
  `tabs.onActivated` / `onUpdated` tab ids), site blocklist (settings),
  draft in `chrome.storage.session`.

## WP2 — Answers & follow-up

- Markdown rendering of answers (sanitised: no raw HTML, safe links open in a
  new tab), copy, live refresh while expanded and non-terminal (poll
  `browser_context_result`), follow-up composer on a row whose conversation is
  offered as a `session` target (re-uses the delivery-target path).

## WP3 — Multi-page

- Contract: `additionalContexts?: BrowserPageContextV1[]`; limits
  `maxPages` (10), `totalContextBytes`; `requestBytes` raised to cover them.
- Extension: optional `tabs` + per-origin optional host permissions; tab
  picker; per-tab extraction.
- Host: per-page fences, fingerprint over ordered URLs, row stores page count
  - hosts; `describesSameCapture` covers all pages.

## WP4 — Attachments

- RPCs `browser_attachment_upload_{init,chunk,commit,abort}`
  (`protocol/companion-commands.json`, generated contract, Rust allowlist,
  `data_sync.rs` routing, desktop-write-source → `lib/browser-companion/`),
  capability `browser.submit`, idempotency per manifest.
- Host staging: `lib/browser-companion/attachments.ts` over
  `session-attachment-uploads` (device `host:browser-companion`, keyed by
  submission id until bound); `enqueueOnHostAuthority` passes refs.
- Extension: visible screenshot (`captureVisibleTab`), region crop editor in
  panel, full-page stitch (scroll + capture, rate-limited), tab PDF fetch,
  context-menu image fetch; preview thumbnails; remove.

## WP5 — Background status

- `alarms` + `chrome.storage.session` last-seen statuses in the service worker;
  badge text / colour; optional `notifications` with click → deep link;
  settings toggle; socket status hints (WP6) when connected.

## WP6 — Device socket + `browser.drive`

- Rust: `SocketChannel::BrowserCompanion` (`/ws/browser-companion`,
  capability `browser.read-own`), `ws_browser_companion.rs` on the
  `ws_worker` pattern; registry of connected browser devices; request/response
  correlation with deadline; per-frame `browser.drive` check; kill switch.
- Security store: `BROWSER_CLASS_CAPABILITIES = submit, read-own, drive`;
  enrollment still grants submit + read-own; desktop toggle grants drive.
- Tauri / headless command `companion_browser_extension_call`,
  `companion_browser_extension_devices`.
- Desktop UI: Browser Companion card lists paired browsers, connection state,
  "Allow agents to act in this browser".

## WP7 — Extension engine

- `lib/browser/extension-engine.ts` implementing `BrowserEngine`;
  `BrowserEngineBackend += "extension"`; `routeEngine` preference +
  conversation binding; `browser_open` backend enum; unsupported feature map.
- Delivery target `browser-agent` (Host `targets.ts`): binds the new
  conversation to the device + tab and adds browser tools via an
  `AgentCapabilityGrantV1`.
- Extension: socket client in the service worker (heartbeat), op executor
  (`scripting` + bundled overlay copy, isolated/main worlds), tab group,
  per-site decisions UI, in-page acting bar with Stop / Take over, finalize.

## WP8 — Docs & gates

ADR-0154 status line, subsystem map row, changeset, preflight, gates.
