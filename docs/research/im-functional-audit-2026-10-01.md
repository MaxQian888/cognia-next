# IM functional audit and live-test preparation

Date: 2026-10-01, Asia/Shanghai. Research began on 2026-09-30.

User scope: assess the existing IM system before implementation; prepare real Feishu testing and guide personal QQ/group access through NapCat + OneBot on this Mac. The user can create a Feishu enterprise app and add it to a test group, but has not configured Cognia yet.

Checkout anchor: `dev`, HEAD `6c7de49f5`, with substantial pre-existing concurrent changes. Results describe the working tree when the commands ran, rather than a clean committed release. During the initial read-only audit no product source, credentials, external app configuration, or real messages were changed. Implementation was subsequently authorized; see the resolution section below. This new report records current evidence separately from older protocol research.

## Authorized fixes — 2026-10-01

The confirmed code/tooling gaps have now been repaired in this working tree:

- Feishu live observer separates target App ID (history sender) from Open ID (mention), reads the documented top-level bot-info envelope, follows chat/history pages and topic containers, retains reply-response thread IDs, deduplicates by message ID, and reports pagination/business/permission failures. Dedup state is committed only after all pages succeed. Doctor now probes history access while explicitly leaving target scopes/subscriptions as manual checks.
- OneBot is registered in the existing CLI/config/driver/report system. A new per-platform driver was necessary because personal QQ needs human input rather than the bot-driven injection used by the existing drivers. It observes NapCat through an authenticated HTTP entry, verifies a distinct human sender and native mention/quote segments, paginates history, and uses the shared fixture-hit and duplicate-window checks. It does not send or delete QQ messages. The standard IM contract script now includes existing OneBot transport/contract tests.
- Bootstrap test fixtures have a database name and isolate the execution bridge; a lifecycle test verifies the bridge is started and disposed. All former hot-reconcile failures pass. No production bootstrap workaround was added for an invalid mock database.
- QQ Official new configurations default to webhook; existing gateway configurations are preserved. Webhook credential testing only requests a token, while gateway testing additionally resolves its endpoint. Neither success message claims real event delivery.
- NapCat form hints and English/Chinese setup guides use current network entries and per-entry tokens, include macOS setup, and distinguish WebUI, HTTP-observer and WebSocket ports/tokens. Feishu documentation names message/history/include-bot/card permissions. The full bot-driven two-turn test needs unmentioned bot-event permission for turn two.
- OneBot A2UI controls are explicitly labeled read-only, including when the mirror is empty. The fallback points to Cognia's linked conversation/run controls; it does not imply numeric QQ replies execute callbacks. A functional acceptance table covers real media, drafts, permission failures, workflows, recovery and isolation.

Verification after implementation:

| Check                                       | Result                                                                                         | Boundary                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Connectors and affected configuration forms | 346 suites passed; 5,702 tests passed; one opt-in benchmark skipped                            | Jest simulated platform/component tests                              |
| Shared live harness                         | 253 tests passed; two subsequently added Feishu/config cases passed in a 37-test focused rerun | Real local HTTP fixture servers, not authenticated platform accounts |
| Execution bridges                           | 2 suites / 18 tests passed                                                                     | Separate bridge behavior after bootstrap fixture isolation           |
| Native OneBot reverse WebSocket             | 13 passed                                                                                      | Actual loopback sockets and auth/event tests; no QQ login            |
| Scoped ESLint, Prettier, diff whitespace    | Passed                                                                                         | Changed code                                                         |
| i18n build/freshness/parity                 | Passed                                                                                         | Both source locales and generated bundles                            |

Evidence: `/tmp/cognia-im-fixes-jest.json`, `/tmp/cognia-im-fixes-node.log`. Rust command: `rtk cargo test -p cognia-connectors --lib ws_server::tests --no-default-features -- --nocapture`.

The production-build TypeScript configuration failed with 6,906 diagnostics, mostly under `cli/dist`, `web`, `target/debug` and `browser-extension`; none named the changed TS/TSX files. This configuration overrides the root exclusions and pulls in those trees. The normal root TypeScript configuration also failed with 7 diagnostics outside the changed TS/TSX files (including CLI test ProcessEnv fixtures, workflow publication argument counts, and a missing sharp declaration). This is a failed repository-wide gate, not a passing typecheck; no unrelated files were changed to hide it. Logs: `/tmp/cognia-im-fixes-tsc-root.log` and `/tmp/cognia-im-fixes-tsc-16g.log`. The earlier 4/8 GiB attempts ran out of heap; both reported checks completed with the repository’s 16 GiB allowance. No credentials, real Feishu/QQ messages, account configuration, installation, or live UI were changed. Real delivery, attachment bytes and client approvals remain **NOT_RUN**, pending user-provided test accounts/configuration. The following sections retain the original audit findings as baseline evidence, not unresolved-fix claims.

API references were rechecked on 2026-10-01: Feishu history/receive/bot-info/card-callback docs, NapCat configuration, Tencent BotGo guidance, and NapCat history source at revision `26d7533e0f5800fdff865ab2f2ad7692917e1076`.

## Current conclusion

The IM system has substantial implementations and regression coverage, including adapter factories, native transports, durable inbound/outbound work, shared conversations, policies, approval authorization, and platform content projection. It is ready to prepare live testing, but real Feishu and QQ acceptance has not been established in this run.

The audit found defects in the Feishu live observer, outdated NapCat setup examples, missing OneBot live-harness coverage, and a reproducible bootstrap test-fixture failure. These categories must remain distinct from defects reproduced through a real platform account.

## Verification performed

| Check                                                                          | Actual result                                                                    | Evidence boundary                                                    |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Connector logic, all built-in adapters, selected Feishu/QQ configuration forms | 345 suites passed, 1 failed, 1 skipped; 5,687 tests passed, 12 failed, 1 skipped | TypeScript/Jest and simulated transports, not real platform delivery |
| Feishu adapter subset within that run                                          | 37 suites / 657 tests passed                                                     | Adapter implementation and simulated protocol responses              |
| OneBot adapter subset within that run                                          | 15 suites / 275 tests passed                                                     | Adapter implementation; no real NapCat or QQ session                 |
| QQ Official subset within that run                                             | 10 suites / 133 tests passed                                                     | Different QQ integration from the user's chosen OneBot path          |
| Live-harness unit/integration tests                                            | 241 tests passed                                                                 | Includes fake platform servers; does not prove live Feishu           |
| Bootstrap isolated reproduction                                                | 1 selected test failed, 61 filtered tests skipped                                | Reproduces the bootstrap mock problem below                          |
| Agent-state/workflow bridges and connector identity                            | 3 suites / 31 tests passed                                                       | Bounds the bootstrap finding; these suites use their own fixtures    |
| Inbox and connector hooks                                                      | 74 suites / 706 tests passed                                                     | Component/hook tests, not native UI acceptance                       |

Commands actually run:

```sh
rtk pnpm exec jest lib/connectors components/settings/connections/forms/lark components/settings/connections/forms/lark-config.test.tsx components/settings/connections/forms/onebot-config.test.tsx components/settings/connections/forms/qq-official-config.test.tsx --runInBand --silent --forceExit --json --outputFile=/tmp/cognia-im-audit-2026-09-30-jest.json
rtk pnpm im:test:unit
rtk pnpm exec jest lib/connectors/bootstrap/install-connector-runtime.test.ts --runInBand --forceExit -t 'registers \+ boots a newly enabled adapter' --json --outputFile=/tmp/cognia-im-bootstrap-repro-2026-09-30.json
rtk pnpm exec jest lib/execution/agent-state-bridge.test.ts lib/execution/workflow-bridge.test.ts lib/connectors/self-identity.test.ts --runInBand --silent --forceExit
rtk pnpm exec jest components/inbox hooks/connectors --runInBand --silent --forceExit --json --outputFile=/tmp/cognia-im-ui-audit-2026-10-01-jest.json
```

The skipped connector test is the opt-in 1,000-job outbound benchmark. Coverage was not requested or run. Rust tests, a new native build, browser E2E, real Tauri UI, live accounts, and actual model-provider acceptance were not run. The filesystem had approximately 3.7 GiB free at preflight; a fresh native/full build was not attempted. No files were deleted to free space.

## Implementation and acceptance matrix

| User path                                                          | Existing implementation/evidence                                                                                | Remaining acceptance                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Configure/start/stop/reconnect an adapter                          | `lib/connectors/adapter-registry.ts`, bootstrap, runtime supervisor, form tests                                 | Save a real adapter; verify transport, identity, restart and credential rotation in the running host          |
| Private messages, group mentions, replies and conversation context | `bus.ts`, `conversation-admission.ts`, `policy-eval.ts`, `runtime.ts`, adapter parsers                          | Real user ingress, reply to the bot without a new mention, correct group/topic, no context leakage            |
| Automatic/draft/manual delivery                                    | Runtime and `inbox-writes/local.test.ts`: governed queue, edited draft, idempotency, interrupted-write recovery | The visible platform message must match the approved draft and appear once                                    |
| Permissions and interactive approvals                              | `callback-authorization.test.ts`: actor scope, expiry, consume-once and concurrent clicks                       | Feishu client button click, correct actor, expiry, denied click, persisted receipt and same-card/topic update |
| Media, quotes, history and forwarding                              | Feishu/OneBot upload, parser and contract tests                                                                 | Real image/file/voice/video bytes, usable attachment, parent message, history pagination and format limits    |
| Recovery, throttling, duplicate delivery and dead letters          | Durable jobs, rate limiting, circuit breaker, supervisor and outbound tests                                     | Real connection restart/wake, process interruption, no duplicate model turn/send, inspectable retry failure   |
| Workflow and execution presentation                                | Workflow bridge, run presentation and callback/control tests                                                    | Real workflow trigger, status updates and safe approve/cancel path on the platform                            |
| Web/mobile paired control                                          | Browser specs use host mocks; mobile draft spec asserts RPC retry and idempotency                               | Actual paired host plus external delivery; a viewport/mock does not establish native acceptance               |
| Feishu web entries, menus and Workbench                            | Dedicated entry/form/API modules; browser entry specs mostly cover missing context/login routing                | Separate OAuth/public-ingress/client acceptance after the basic bot lane works                                |

OneBot supports text, mentions, quotes, images, files, voice/video, deletion, history and selected upstream extensions. Forwarding, file upload and emoji reactions depend on the upstream implementation/actions. It does not have native edit, typing, or interactive buttons/forms. Its A2UI mapper projects readable text/images/action descriptions; a visible description alone does not prove an approval action is executable. Approval scenarios need a separately verified command or Cognia approval surface.

Feishu declares richer capabilities, including cards, editing, threads, history, reactions and media. Some A2UI components are simulated or use text fallback; native capability declaration is not evidence of the required tenant scope or client rendering.

## Confirmed gaps and risks

### 1. Feishu live observer compares incompatible identities

Location: `scripts/smoke/im-live/drivers/lark.mjs`, `pollTargetMessages`, line 189; `lark.test.mjs`, line 49.

The runner config has only `targetBotOpenId`. History polling keeps a message only when `item.sender.id === targetBotOpenId`. Current official history responses use `sender.id_type = app_id` for an application sender; mentions use Open IDs. The unit fixture instead supplies an application sender with an Open ID, masking this discrepancy.

Executed synthetic reproduction using the actual exported driver and an injected HTTP response: one valid bot history message with `id=cli_target`, `id_type=app_id`, and `sender_type=app`, while target mention ID is `ou_target`. Expected one observed reply; actual zero. No credentials or external requests were used. This can incorrectly classify a working bot as a timeout.

Before relying on this harness: retain the target App ID separately from its mention Open ID and assert realistic history identity shapes.

### 2. Feishu observer ignores pagination and topic history

Location: the same driver's `pollTargetMessages`, lines 176–203.

It requests `container_id_type=chat`, ascending history, `page_size=50`, with the original start time on every poll. It never follows `has_more/page_token` and never queries a `thread` container. The official API says ordinary chat history returns only topic roots; topic replies require thread history.

Executed synthetic reproduction: a history response with `has_more=true` and `page_token=page2` resulted in one history request and no next-page request. Above 50 messages, replies outside the first page cannot be observed. Topic-reply invisibility is established by the source/API contract; no real-topic reproduction was run.

### 3. Live coverage omits OneBot and most functional paths

`scripts/smoke/im-live/platforms.mjs` lists only Telegram, Slack, Discord, Lark and Matrix. `run.mjs` performs two text turns: mention, then reply to the bot's response, plus model-fixture observation and a duplicate window. It does not cover private/group/media/card/approval/workflow/restart combinations comprehensively.

For QQ, use manual real-client acceptance initially. A future OneBot fake-server lane should test the native transport/host seams; a real NapCat canary must additionally test upstream QQ delivery. Neither should be labeled QQ Official acceptance.

### 4. Bootstrap regression tests fail due to an incomplete database mock

All 12 failures are in `install-connector-runtime.test.ts`, in the hot-reconcile block. An isolated rerun emits:

```text
[connector-bus] runtime bootstrap failed: Cannot read properties of null (reading 'references')
```

The test's `getDb()` mock has only `adapterInstances.update` and no database `name`. Bootstrap starts the workflow bridge, which starts the agent-state bridge. In `lib/execution/agent-state-bridge.ts`, `activeBridge?.databaseName === databaseName` compares two undefined values when the bridge is null and the mock name is absent; the next line accesses `activeBridge.references`.

This blocks installation of the test's adapter watcher. A real Dexie database has a string name, so this evidence does not establish that configuring a real adapter fails. Correct the bootstrap fixture and isolate its external bridge dependencies before using this suite as a readiness gate. Bridge-specific tests passed separately.

### 5. NapCat setup examples drift from current upstream

`docs/content/docs/zh/connectors/onebot-setup.md` uses `wsReverse` and top-level `accessToken` in `napcat.json`. The current NapCat documentation describes `config/onebot11_<QQ>.json`, `network.websocketClients`, and per-client `token`; its WebUI exposes WebSocket client/server entries.

The Cognia reverse endpoint itself is correct. Use the current NapCat WebUI and the generated Cognia URL, rather than copying the old configuration object.

### 6. Feishu live permissions need an explicit checklist

Current Feishu receive-event documentation differentiates user-only group permissions from permissions that include other bots. The live driver is a second app bot; successful manual-user testing does not guarantee that this driver's messages are delivered to Cognia.

For mention-only bot-driver ingress the target needs `im:message.group_at_msg.include_bot:readonly`; for unmentioned bot messages it needs `im:message.group_msg.include_bot:read`. Keep these optional for the first human-client tests. The current driver doctor checks token/identity/chat reachability, but does not prove target event subscription, target receive scopes, or target Cognia configuration.

### 7. QQ Official onboarding remains a separate compatibility concern

Outside the user's chosen path: the QQ Official form defaults to gateway, and its setup guide emphasizes WebSocket without public ingress. Tencent's official BotGo README warns of WebSocket retirement and documents webhook setup. The Cognia adapter already implements webhook and the form exposes its URL; documentation/defaults need review against the user's actual open-platform account. This audit did not verify that every current QQ account rejects gateway.

## Feishu preparation: first use one app and human-client tests

1. Create a dedicated enterprise app in the [developer console](https://open.feishu.cn/app), enable bot capability, and create a test group containing the user and bot.
2. Record App ID/App Secret and the event Verification Token. Enter credentials directly into Cognia's Feishu form. Do not paste secrets into this report or the conversation. Encrypt Key is optional unless encryption is enabled.
3. Use long connection for the initial local-desktop lane. Configure both message events and card callbacks to use the supported delivery mode; subscribe to `im.message.receive_v1` and `card.action.trigger`. If the console requires an active client before saving long-connection configuration, first save/start the Cognia adapter with its credentials.
4. Start with `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, and `im:message:send_as_bot`. Add `im:resource` for media. Add `im:chat` for chat inspection/management scenarios. Grant additional message-read plus `im:message.group_msg` scopes when testing group history/context; the official history API has separate group requirements.
5. Publish a new version containing scopes/subscriptions and include the test user in the availability range. Add the bot to the group. Permission checkboxes alone do not establish published authorization.
6. In Cognia's platform connection settings, create Feishu with long connection; verify running status, bot identity and audit logs. Keep one active host for this application during initial acceptance.
7. Supply non-secret test context: adapter ID, bot App ID/Open ID if available, group Chat ID, and which user may approve. IDs can also be resolved locally after configuration.

A second Feishu app is only needed for the existing automatic driver. Its secret belongs in the local `.env.im-live.local`; the driver and target must be different apps in the same test group. First fix the observer defects, then use `rtk pnpm im:test:target`, `rtk pnpm im:test:doctor -- --platform lark`, and `rtk pnpm im:test:live -- --platform lark`. The target launcher supplies an Anthropic-compatible deterministic fixture; provider-specific base URLs/OAuth and frozen runtime snapshots can bypass it. A model-fixture hit must be observed rather than assumed.

## QQ preparation: this Mac, NapCat + reverse OneBot

Use a dedicated test QQ account, another QQ account to send messages, and a test group containing both. The current Mac installer changes the QQ app entry; follow its current instructions and retain its original-entry backup. Installation/login were not performed in this research turn.

1. Download the [NapCat Mac installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases/) linked by upstream. Its README recommends the Mac App Store QQ build and describes macOS App Management permission for switching the entry. Verify the installed QQ/NapCat versions before testing.
2. Run the installer, install NapCat, choose the NapCat entry and start QQ. Complete login yourself. Open WebUI using the local URL/token printed by the running process; default WebUI port is 6099, but use the actual logged port. WebUI login token and OneBot transport token are different credentials.
3. In Cognia add OneBot (QQ), enter the logged-in test QQ number, expected client NapCat, reverse WS, and a chosen Bearer Token. Save and reopen the connection to copy the generated URL, normally `ws://127.0.0.1:7842/ws/onebot/<adapterId>`.
4. In NapCat WebUI, Network configuration → new WebSocket client. Enable it; set URL to the copied Cognia endpoint, `token` to the same Cognia Bearer Token, message format to `array`, `reportSelfMessage=false`, reconnect interval 5000 ms, heartbeat interval 30000 ms. Save and enable. These intervals follow the current upstream example and are not Cognia protocol requirements.
5. In Cognia use the current-connection probe and identity display. The registered UIN must match the configured QQ number. A running/connected badge alone is not acceptance.
6. From the other account, send one private message, then a real client-selected @mention in the group, then reply to the bot message without a new @. Confirm Cognia records the sender/message, one model turn occurs, and exactly one reply appears in the correct QQ conversation.

This same-host lane needs no public tunnel or QQ developer App ID. The reverse listener binds to loopback; another machine/container would need a deliberately different networking plan. Follow [current NapCat WebUI configuration](https://doc.napneko.icu/config/basic), not the repository's old `wsReverse` JSON.

## Live acceptance order and recorded evidence

| Order | Test                                                     | Required observable result                                                                                         |
| ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1     | Identity/connection, private text, group @, reply-to-bot | Correct adapter/sender/conversation, one inbound job, one model turn, one visible reply                            |
| 2     | Unmentioned messages and two users in two groups         | Behavior matches trigger policy; no cross-user/group context or unsolicited sends                                  |
| 3     | Image/file/voice/video, long text, quote/forward         | Actual readable content or explicit supported fallback; no missing bytes/text                                      |
| 4     | Draft/edit/approve/reject/manual reply                   | Platform gets the edited approved content once; rejection sends nothing                                            |
| 5     | Feishu A2UI/tool/workflow approval                       | Authorized click succeeds; unauthorized/expired/repeated clicks are refused; receipt and card/topic are consistent |
| 6     | Disconnect/restart/wake and duplicates                   | Recovers ownership and processing; no duplicate reply; recovery-required failures remain visible                   |
| 7     | Error/retry/dead-letter                                  | Actionable audit and delivery state; controlled retry does not duplicate delivery                                  |
| 8     | Paired remote control and Feishu entry surfaces          | Separate actual host/client/OAuth evidence after the local bot lane passes                                         |

Per case record adapter ID, platform message IDs, conversation/topic key, inbound/outbound job status, run/provider, model-fixture hit where applicable, timestamps/latency, retry count, visible platform result and relevant error. Do not record secrets or unrelated conversation content.

First feasibility inputs are now known: enterprise self-built Feishu app is available; QQ uses NapCat/OneBot on this Mac. Remaining operational inputs are the configured dedicated connections, test accounts/groups, and an available model/provider for live product behavior. Real client/card interaction is needed even if the automated driver is repaired.

## Sources

Checked during this audit; official Markdown endpoints were read with `curl` because the web reader rejects `text/markdown`.

- [Feishu receive-message event and receive scopes](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [Feishu history API: sender identities, paging and thread containers](https://open.feishu.cn/document/server-docs/im-v1/message/list)
- [NapCat current WebUI/OneBot configuration](https://doc.napneko.icu/config/basic)
- [NapCat deployment guide: Mac installation entry](https://doc.napneko.icu/guide/boot/Shell)
- [NapCat Mac installer README](https://github.com/NapNeko/NapCat-Mac-Installer)
- [Tencent official BotGo README: webhook and gateway warning](https://github.com/tencent-connect/botgo)
