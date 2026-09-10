# IM protocol compliance audit — 2026-09-08

Status: Code audit and identified fixes completed; scoped acceptance passed. Repository-wide coverage and live-account certification remain unverified. This is an evidence ledger, not a universal compliance certification.

Scope: all 11 existing built-in adapters, their declared messaging capabilities, shared runtime, and Rust ingress/transports. Full behavior means preserving content and routing, implementing declared capabilities, respecting platform limits, and surfacing unsupported operations truthfully. It does not mean implementing every unrelated platform API. The working tree had extensive pre-existing concurrent modifications; changes are additive to that baseline.

## Verification

- Baseline: `pnpm exec jest lib/connectors/adapters --runInBand --silent`: 164 suites, 163 passed; 2414 tests, 2412 passed. Two Lark card-image upload tests failed. Jest retained open handles after completion.
- Lark rate-limit regression: six new assertions failed because `retryAfterMs` was absent; after propagating `x-ogw-ratelimit-reset`, 4 suites / 110 tests passed.
- Real-account end-to-end verification and complete repository coverage remain unverified; see limits below.

## Findings and work queue

| Platform        | Finding                                                                                                | State                                             |
| --------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Lark            | Preserve rate-limit reset headers, including legacy HTTP 400 errors                                    | Implemented; regression tests pass                |
| Lark            | Fetch thread history from thread container; verify managed root chat identity                          | Implemented; regression tests pass                |
| Lark            | Card-image upload baseline failures                                                                    | Concurrent changes now pass existing tests        |
| Lark            | WebSocket service ID, PONG configuration and reconnect policy                                          | Implemented; Rust tests pass                      |
| Lark            | Encrypt Key webhook signature over raw body, URL verification handling                                 | Implemented; signed router tests pass             |
| WeCom           | Private callbacks without chatid, voice content, text/media quotes, all image decryptions              | Implemented; adapter tests pass                   |
| DingTalk        | Parse content.richText official schema                                                                 | Implemented; adapter tests pass                   |
| QQ Official     | api.bot.qq.com domain migration; remove withdrawn proactive-send fallback                              | Implemented; adapter tests pass                   |
| QQ Official     | Native public-URL media upload and send; quota reservation and partial-delivery semantics              | Implemented; 125 tests pass                       |
| Telegram        | Preserve MarkdownV2 entities, whitespace and surrogate pairs across chunks                             | Implemented; targeted tests pass                  |
| Telegram        | Local media multipart upload through Rust                                                              | Implemented; targeted tests pass                  |
| Telegram        | Migration response handling and entity-preserving text edit                                            | Implemented; regression tests pass                |
| Discord         | Composite public message IDs; invalidate obsolete gateway sessions                                     | Implemented; adapter tests pass                   |
| Discord         | Label modal layout, application/context commands, correct interaction ACK types                        | Implemented; adapter and signed router tests pass |
| Slack           | Unified threadId/replyTo for messages and uploads; deliver slash commands                              | Implemented; adapter and signed router tests pass |
| Shared          | Command invocation IDs excluded from automatic reply anchors                                           | Implemented; runtime regression tests pass        |
| Matrix          | Honor HTTP Retry-After before legacy retry_after_ms                                                    | Implemented; adapter tests pass                   |
| WeChat OA       | Native image/voice/video upload and send; download MediaId/video_url; reject HTTP 200 API errors       | Implemented; adapter and Rust tests pass          |
| WeChat Personal | Official nested CDN fields, server IDs/timestamps, voice text, quoted content, all inbound attachments | Implemented; targeted tests pass                  |
| WeChat Personal | Official encrypted outbound CDN handshake and media sends                                              | Implemented; regression tests pass                |
| OneBot          | v12 channel routes, upload_file/get_file, data/URL fallback, checksum and capability gating            | Implemented; 276 tests pass                       |

## Follow-up fixes

- Matrix: A2UI image fallback retains source URL, alt and full text mirror in plain/formatted content; send/edit return explicit downgrade metadata without claiming native A2UI image support.
- WeCom: no UTF-8 truncation; full replies split into protocol-sized chunks; failed media uploads cannot silently disappear.
- DingTalk: ordered rich text/media parsing, authenticated download-code resolution, and callback ACK only after processing; failures receive an error ACK.
- Telegram/Discord: mixed A2UI surfaces retain their entire text mirror alongside native controls and return downgrade metadata. Unsupported opaque cards fail before media uploads or sends. Location and poll data survive as explicit text downgrades.
- QQ/OA: direct-adapter calls preserve mention/reply/location/poll text with downgrade metadata and reject unsupported opaque cards before delivery. There is no central automatic degradation walker, so adapter boundaries enforce this themselves.
- Personal WeChat: strict PKCS#7 validation; desktop file-URI uploads with size checks before and after reading; emoji/poll/card content preserved with text downgrade diagnostics; code indentation/whitespace retained.
- Personal WeChat login: latest SDK uses a QR payload URL, not base64 PNG. API handling now supports verification-code requests, redirect hosts, official bot identity, and 35-second polling; wizard integration, verification retries, terminal states, validated redirects, sequential polling and close cleanup pass component tests.

## Supported boundaries

- QQ proactive messages were withdrawn on 2025-04-21. Expired/missing passive anchors and exhausted reply quotas return explicit validation failures. Public media is scene-specific; unsupported file uploads are not advertised. Partial delivery is nonretryable to prevent duplicate prefixes.
- WeChat OA uses the documented active customer-service reply mode. Passive five-second HTTP replies are an alternative deployment mode, not an advertised capability. Native arbitrary-file sending is absent from the custom-message API; the adapter does not declare it. Video sends require a thumbnail media ID.
- Personal WeChat attachment loading retains the application's explicit 20 MiB cap, with pre-read and post-read validation for local files; this is an application resource limit, not claimed as a Tencent protocol limit.
- Personal WeChat is assessed against Tencent's official openclaw-weixin SDK 2.4.8. It is not an independently published standards-track protocol. Zero-valued response status fields may be omitted in protobuf JSON; HTTP errors and explicit ret/errcode errors remain failures.
- OneBot v12 is a candidate specification. Extension actions remain gated by runtime-discovered support.
- No real-account end-to-end certification has been performed. Protocol fixtures and HTTP/router tests cannot prove credentials, account permissions, network access, or platform approval.

## Final acceptance snapshot

- Latest combined run, including all adapter suites, shared runtime/runner, commands/events/effective capabilities, and the updated login wizard: **172 suites / 2931 tests passed**, exit 0.
- Configured project TypeScript check: **no errors**, exit 0.
- Entire adapter-tree, touched shared source/tests and login UI ESLint: exit 0.
- Rust connector crate: **257 tests passed**, Clippy passed; no later Rust source edits.
- i18n build/check/lint: passed; independent login i18n review passed after correcting raw-English error toasts.
- No commits or staging performed. The workspace contained substantial prior/concurrent edits; the full working diff must not be attributed solely to this task.

## Verification updates

- Lark + Slack + shared event tests: 52 suites, 873 tests passed. The original Lark upload failures no longer reproduce after concurrent changes.
- Personal WeChat inbound/protocol batch: 11 suites, 109 tests passed before subsequent quote and media success-path additions; newest index suite passes 22 tests.
- Rust connector crate: 252 tests passed after generic multipart uploads and WeChat media-error validation; Clippy passed in the preceding transport batch.
- Current configured TypeScript check: no errors.
- Four Western adapter batch: 55 suites / 1010 tests passed after latest migration, formatting, and explicit platform-limit handling.
- Rust connector crate after lifecycle/auth/padding follow-up: 257 tests passed; Clippy passed.
- Personal parser coverage: lines/statements/functions 100%, branches 90%; 17 tests passed.
- Runtime reply-reference regressions: full runtime suite 115 tests and native presentation runner 15 tests passed. Source IDs are also excluded from workflow and persisted native-run bindings when an event is not replyable.
- Shared OneBot effective capability and startup variant tests: 74 tests passed; v12 upload_file is no longer gated on v11 upload_group_file, and startup action discovery persists available features.
- Consolidated final connector/runtime/event/command/capability regression run: **171 suites / 2893 tests passed**, exit 0. Entire adapter-tree and touched shared-source ESLint passed, exit 0.
- Login wizard: 31 tests passed; focused coverage lines/statements 99.38%, branches 92.36%, functions 100%. ESLint, i18n generation freshness/parity, missing-key checks and independent i18n review passed. QR-request/poll errors use localized UI messages; technical details remain in logs.
- Browser verification boundary: no current Cognia dev/Tauri server or reusable desktop IPC browser mock was available. Existing browser route disables the desktop-only QR action. No live QR login/account mutation was attempted, and no screenshot from an older build is used as evidence.
- Login auth focused coverage: lines/statements/functions 100%, branches 97.14%; 16 tests passed.
- Effective capability projection coverage: all four metrics 100%; 42 tests passed.
- A combined 169-suite adapter run overlapped active red/green edits in Discord, Slack, and DingTalk and therefore failed 8 assertions. This intermediate run is not treated as a stable final result; the subsequent consolidated run passed as recorded above.
- Full repository coverage attempted with `pnpm test:coverage --out coverage/im-protocol-2026-09-08 --jobs 1 --workers 2`. Unrelated title-bar/chat-header assertions failed, followed by a 4 GB Jest heap exhaustion. No complete repository coverage report was produced; the coverage gate is not claimed passing.
- WeChat OA focused media coverage: media.ts lines 98.29%, branches 95.38%, functions 100%; inbound-media.ts lines 97.56%, branches 90.47%, functions 100%. Standalone coverage invocation still exits nonzero because repository configuration also requires unrelated coverage groups.

## Official sources

- [Lark history](https://open.feishu.cn/document/server-docs/im-v1/message/list.md): thread container required for ordinary-chat thread replies; time range unsupported for thread containers.
- [Lark rate limits](https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control.md): wait the seconds specified by x-ogw-ratelimit-reset; older endpoints may use HTTP 400 with code 99991400.
- [Lark SDK websocket](https://raw.githubusercontent.com/larksuite/oapi-sdk-python/v2_main/lark_oapi/ws/client.py).
- [Lark SDK dispatcher](https://raw.githubusercontent.com/larksuite/oapi-sdk-python/v2_main/lark_oapi/event/dispatcher_handler.py).
- [WeCom official SDK message types](https://raw.githubusercontent.com/WecomTeam/aibot-node-sdk/main/src/types/message.ts).
- [DingTalk bot messages](https://opensource.dingtalk.com/developerpedia/docs/learn/bot/message/).
- [QQ changelog](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html).
- [QQ official sending contract](https://raw.githubusercontent.com/tencent-connect/bot-docs/master/docs/develop/api-v2/server-inter/message/send-receive/send.md).
- [Telegram Bot API](https://core.telegram.org/bots/api).
- [Discord gateway close codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes).
- [Discord component reference](https://docs.discord.com/developers/components/reference).
- [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/).
- [Matrix client-server rate limits](https://spec.matrix.org/latest/client-server-api/#rate-limiting).

- [Tencent personal WeChat SDK](https://github.com/Tencent/openclaw-weixin) and [published package](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin), inspected version 2.4.8.
- [WeChat OA customer-service messages](https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage).
- [WeChat OA temporary uploads](https://developers.weixin.qq.com/doc/service/api/material/temporary/api_uploadtempmedia).
- [WeChat OA temporary downloads](https://developers.weixin.qq.com/doc/service/api/material/temporary/api_getmedia).
- [OneBot v12](https://12.onebot.dev/).

- [Slack profile status](https://docs.slack.dev/reference/methods/users.profile.set/): reject over-limit status text without truncation; clear both status_text and status_emoji.
