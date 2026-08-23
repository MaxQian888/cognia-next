# Remaining external-agent official-support baseline (2026-08-23)

## Scope and method

This audit covers every built-in external-agent surface still present after excluding Claude Code, Codex CLI/app-server, and OpenCode:

- shared ACP and its Gemini CLI, GitHub Copilot CLI, Kiro CLI, Qwen Code, Pi ACP, Factory Droid, Cursor CLI, and generic/custom presets;
- Pi native RPC;
- DeepSeek Harness SDK and ACP profiles;
- A2A JSON-RPC endpoints.

The inventory was derived from `lib/ai/agent/external/presets.ts`, `lib/ai/agent/external/ecosystem-adapters.ts`, `protocol/external-agent-runtimes.json`, `protocol/agent-capabilities.json`, and protocol registration in `lib/ai/agent/external/manager.ts`. Claims were checked against vendor documentation, vendor source/release tags, and the official ACP Registry as retrieved on 2026-08-23. Confirmed defects were reproduced with focused tests and corrected in the shared working tree; the remaining gaps are called out explicitly below.

## Executive conclusion

The architecture is reasonable: one ACP v1 adapter handles the common protocol, while Pi RPC, A2A, and DeepSeek Harness SDK retain their distinct lifecycle semantics. The adapters also preserve the important completion boundaries: ACP completes on the `session/prompt` response, Pi completes only on `agent_settled` (not `agent_end`), DSH SDK waits for session terminal state rather than its prompt-admission receipt, and A2A uses task/message terminal state.

There are no remaining confirmed P0 defects after the current shared-tree corrections. The highest-priority confirmed drift was Factory Droid's launch argument: the current official ACP Registry publishes `droid exec --output-format acp-daemon`, while the repository previously used `acp`. The working tree now uses `acp-daemon` in both the preset and runtime catalog. The two Pi catalog URLs that previously pointed to the unrelated `parallel-web/pi` repository are also corrected in the working tree.

The remaining issues are P1 rather than launch blockers:

1. The generic ACP manifest promotes optional, per-agent capabilities to unconditional `native` claims.
2. Cursor and Kiro depend on vendor extension requests that the shared adapter does not wire.
3. Runtime certification is absent for nearly every vendor CLI; several `npx` launches resolve an unpinned latest package on every start.
4. Pi ACP is missing its documented minimum versions and uses an unpinned community bridge.
5. A2A implements a useful JSON-RPC subset but does not model negotiated authentication, signed Agent Cards, or actionable `input-required` / `auth-required` states.
6. The exact managed DeepSeek Harness developer-preview pin is not represented in the shared runtime catalog.

The current working tree also closes seven confirmed P1 findings from this pass: Pi native RPC now forwards base64 image blocks; A2A leaves first-turn `contextId` creation to the server; Pi ACP no longer inherits generic MCP support and now documents its Pi/Node minimums; the managed DeepSeek Harness ACP profile no longer advertises images without an attachment store; and the Gemini/Copilot authentication copy now reflects current supported credentials.

## Current support matrix

| Surface            | Current upstream snapshot                                                                   | Local launch/transport                       | Result                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Generic ACP        | `@agentclientprotocol/sdk` 1.4.0; stable wire version 1, experimental v2 shipped separately | JSON-RPC over stdio/HTTP/WebSocket           | Core v1 lifecycle is sound; static capability claims need correction                 |
| Gemini CLI         | ACP Registry 0.56.0                                                                         | `npx -y @google/gemini-cli --acp`            | Correct command and auth copy; version governance remains unpinned                   |
| GitHub Copilot CLI | ACP Registry 1.0.80, ACP public preview                                                     | `copilot --acp`                              | Correct command and PAT copy; version governance remains unpinned                    |
| Kiro CLI           | Current ACP documentation updated 2026-08-04                                                | `kiro-cli acp`                               | Correct core command; vendor extensions and Windows disclosure missing               |
| Qwen Code          | 0.22.0                                                                                      | `npx -y @qwen-code/qwen-code --acp`          | Correct core command; unpinned runtime                                               |
| Pi native RPC      | 0.84.2                                                                                      | `pi --mode rpc`                              | Lifecycle and base64 image input are correct; certification is one patch behind      |
| Pi ACP             | 0.0.33; requires Pi >=0.80.4 and Node 22+                                                   | `npx -y pi-acp`                              | Experimental label/setup/capability refinement are correct; runtime remains unpinned |
| Factory Droid      | ACP Registry 0.202.0                                                                        | `droid exec --output-format acp-daemon`      | Confirmed command drift corrected in current working tree                            |
| Cursor CLI         | ACP Registry 2026.08.11                                                                     | `cursor-agent acp`                           | Command is valid; vendor extension requests are not handled                          |
| DeepSeek Harness   | upstream 0.1.1-rc.2; Cognia pins 0.1.0-rc.6                                                 | managed Node runtime, SDK JSON-RPC or ACP    | Conservative pin is reasonable; exact catalog certification still drifts             |
| A2A                | released specification 1.0.1                                                                | remote JSON-RPC, including 0.3 compatibility | Core JSON-RPC wire behavior is sound; security/interruption semantics remain partial |

The exact ACP Registry versions and commands above come from the [official live registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json), whose publication pipeline is described in the [ACP Registry repository](https://github.com/agentclientprotocol/registry).

## Confirmed P0 correction

### Factory Droid must use `acp-daemon`

The machine-readable ACP Registry entry for Factory Droid 0.202.0 launches `droid exec --output-format acp-daemon`. Factory's prose integration page still shows the older `acp` spelling, while its release history records the daemon-mode evolution. For an unpinned system binary, following the live registry is the safer compatibility contract. See the [ACP Registry payload](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json), [Factory IDE integration documentation](https://docs.factory.ai/ide-integrations), and [Factory release notes](https://docs.factory.ai/changelog/release-notes).

Status in the 2026-08-23 shared tree: corrected in `lib/ai/agent/external/ecosystem-adapters.ts` and `protocol/external-agent-runtimes.json`. This should still receive one real spawn/initialize/prompt/cancel smoke test before release because the local executable remains unpinned.

## Cross-cutting ACP findings

### P1 — protocol metadata and static capabilities overclaim optional features

The repository labels its schema as `ACP_V1_SCHEMA_VERSION = "1.21.0"`. The installed and current npm SDK is 1.4.0, while the stable ACP wire version exported by the SDK is the integer `1`; no official ACP artifact establishes `1.21.0` as the schema version. The value should be removed, renamed as a Cognia-internal profile revision, or generated from a cited schema artifact. ACP versioning is documented in the [official repository and changelog](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/CHANGELOG.md).

`protocol/agent-capabilities.json` also marks `thinking`, `permissions.set-mode`, `set-model`, `images`, and `mcp` as generically `native`. These are not universal ACP guarantees:

- modes and models are optional session state/configuration advertised by an agent;
- image acceptance is gated by `promptCapabilities.image`;
- MCP attachment is meaningful only when the specific agent consumes the `mcpServers` supplied at session creation;
- Cognia itself defines `thinking` as host-controlled reasoning level, not receipt of thought chunks.

The adapter already gathers live capability/session facts and rejects unsupported image/audio/context blocks. The manifest should therefore use `unknown`/live evidence for these rows, with preset refinements for known exceptions. ACP's initialize/new-session/prompt flow and negotiated capabilities are defined by the [official v1 protocol overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx).

### P1 — vendor extension requests are rejected unless manually registered

`AcpClientAdapter.dispatchAgentRequest()` handles standard client methods and registered underscore-prefixed extensions. There is no preset wiring for current Cursor or Kiro extensions:

- Cursor documents blocking requests such as `cursor/ask_question` and plan/task extensions. Because these method names do not start with `_`, Cognia returns JSON-RPC `-32601` unconditionally. An agent turn that expects an answer can fail or lose its interaction. See [Cursor ACP](https://docs.cursor.com/en/cli/acp).
- Kiro documents `_kiro.dev/commands/*`, `_kiro.dev/mcp/*`, compaction/clear notifications, and session termination extensions. Cognia can technically register underscore handlers but currently registers none. Core prompts work, but the integration is only a core-ACP subset. See [Kiro ACP](https://kiro.dev/docs/cli/acp/).

Recommended fix: add preset-owned extension handlers and capability refinements. At minimum, surface an explicit partial-support notice and ensure unsupported blocking requests become actionable user-visible events rather than a generic protocol failure.

### P1 — runtime certification is systematically missing

Except for the separately audited OpenCode row, these runtime-catalog entries have no `supportedRange`. By the catalog's own policy, every parseable installed version is `supported-uncertified`. Gemini, Qwen, and Pi ACP additionally use unpinned `npx -y` commands and are explicitly waived as governance holes.

The official ACP Registry already supplies exact current artifacts for Cursor 2026.08.11, Droid 0.202.0, Gemini 0.56.0, Copilot 1.0.80, Pi ACP 0.0.33, and Qwen Code 0.22.0. Importing pinned registry distributions plus a small initialize/new-session/prompt/cancel conformance suite would turn those presets from “executable” into evidence-backed support. Until then, the UI should distinguish “launchable, unverified version” from certified support.

## Vendor-specific findings

### Gemini CLI

The command is current. Gemini's ACP dispatcher advertises session load, image/audio/embedded-context prompts, modes, model selection, and MCP transports; Cognia's live negotiation is the right mechanism. See [Gemini ACP mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) and the [current dispatcher source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpRpcDispatcher.ts).

The authentication wording drift found during this audit is fixed in the current working tree: the preset now lists Gemini API key, Vertex AI, gateway, and enterprise Code Assist credentials instead of claiming `GOOGLE_API_KEY` is universally required. Google announced that ordinary individual Google AI Pro/Ultra/free-account service ended on 2026-06-18 while enterprise Code Assist and API-key paths remain available. See the [official service-change announcement](https://github.com/google-gemini/gemini-cli/discussions/28017).

Risk to verify: an open upstream report says Gemini 0.53.0 `session/load` erased the session it loaded. Do not remove resume support globally, but add the current registry version to resume conformance before certifying it. See [Gemini issue 28775](https://github.com/google-gemini/gemini-cli/issues/28775).

### GitHub Copilot CLI

`copilot --acp` is correct, Node 22+ is current, and the local label correctly says ACP is public preview. ACP session options such as reasoning and tool filters are fixed by server startup options rather than `session/new`, reinforcing the need for live capability gating. See [Copilot ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) and [CLI setup requirements](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started).

The upstream changelog introduced ACP in 0.0.397, so `>=0.0.397` is a valid availability floor; a higher exact tested build is still required before claiming newer MCP/config/vision behavior. See the [Copilot CLI repository and changelog](https://github.com/github/copilot-cli).

The PAT wording drift found during this audit is fixed in the current working tree: the environment hint now says “fine-grained PAT” explicitly; classic PATs remain unsupported. OAuth, environment-token, `gh` fallback, and BYOK alternatives still belong to the upstream authentication flow. See [Copilot CLI authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).

### Kiro CLI

`kiro-cli acp` is current, with new/load/prompt/cancel, modes, model selection, and image prompts documented. Kiro also owns the extension surface described above. See [Kiro ACP](https://kiro.dev/docs/cli/acp/).

P1 support disclosure: Kiro officially distributes for macOS, Linux, and Windows, but Cognia intentionally lists only macOS/Linux because external processes require its strict sandbox and there is no Windows exception. This is a defensible product restriction, not command drift, but the preset should say why Windows is withheld. See [Kiro CLI platform support](https://kiro.dev/cli/).

Kiro is not in the official ACP Registry and its proprietary CLI updates independently. ACP was introduced in CLI 1.25.0, giving the runtime catalog a defensible minimum floor even though certification should target a tested exact build. See the [Kiro 1.25 changelog](https://kiro.dev/changelog/cli/1-25/). Keep newer builds executable/uncertified until a version probe plus conformance matrix is established.

### Qwen Code

The 0.22.0 command remains `qwen --acp`; the local `npx` spelling reaches that command correctly. Qwen's bridge owns session multiplexing, streaming, permission mediation, and filesystem integration. See the [Qwen ACP integration guide](https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/), [architecture documentation](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/), and [0.22.0 release](https://github.com/QwenLM/qwen-code/releases/tag/v0.22.0).

No protocol bug was confirmed. The gap is distribution governance: pin the registry version/artifact and document Node 22+ for npm installations. The registry currently adds `--experimental-skills`; Cognia intentionally claims skills unsupported and should not add that flag until the feature is deliberately exposed and tested.

### Pi native RPC

The local JSONL framing and completion behavior agree with the official protocol. In particular, only `agent_settled` produces Cognia's terminal `done`; `agent_end` and `turn_end` are correctly treated as non-terminal because retry, compaction, or queued work may still follow. See [Pi RPC](https://pi.dev/docs/latest/rpc).

The image transport gap found during this audit is fixed in the current working tree: base64 image blocks now map to Pi's documented `images` field, while URL-only image blocks fail explicitly instead of being silently discarded. One P1 governance gap remains:

The preset enforces/documents Pi >=0.84.1, but `protocol/external-agent-runtimes.json` has no `supportedRange`, so lifecycle policy still calls all versions uncertified. Add the lower bound and preferably certify exact versions. Pi 0.84.2 is current and fixes cumulative usage loss in RPC `message_update`, so it should be the next conformance target. See the [Pi 0.84.2 release](https://pi.dev/news/releases/0.84.2).

The current sandbox requirement is correct: Pi's own security documentation says it does not provide a built-in sandbox. See [Pi security](https://pi.dev/docs/latest/security).

### Pi ACP community adapter

The experimental/community label is correct. Current Pi ACP 0.0.33 documents Pi >=0.80.4 and Node 22+, session history/load, streaming, slash commands, and tool updates, but no filesystem/terminal delegation, no thought stream, and MCP parameters accepted without being wired into Pi. See the [Pi ACP repository](https://github.com/svkozak/pi-acp) and [0.0.33 release](https://github.com/svkozak/pi-acp/releases/tag/v0.0.33).

P1 fixes:

- add Pi >=0.80.4 and Node 22+ to the setup hint;
- keep the current working-tree refinement that overrides generic `mcp: native` to unsupported for this preset;
- pin/certify the adapter instead of resolving latest with `npx -y pi-acp`;
- preserve the warning that this adapter cannot provide the same host-side filesystem/terminal and permission boundary as a full ACP agent.

The incorrect `parallel-web/pi` runtime-catalog URL is already corrected to the community repository in the current shared tree.

### Cursor CLI

`cursor-agent acp` is valid: although some prose examples use `agent acp`, the official ACP Registry's current Cursor distribution runs `./dist-package/cursor-agent acp`. Core session creation/load, streaming updates, permission choices, and agent/plan/ask modes are documented. See [Cursor ACP](https://docs.cursor.com/en/cli/acp) and the [ACP Registry payload](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json).

P1 executable discovery risk: Cursor's current installation and ACP prose standardize on the installed command name `agent`, whereas the registry artifact itself is named `cursor-agent`. A registry-managed install makes the local command correct, but a normal user installation may expose only `agent`. Probe `agent` and `cursor-agent`, record the resolved executable identity, and prefer the registry artifact when Cognia manages installation. See [Cursor CLI installation](https://prod.cursor.com/docs/cli/installation).

The blocking extension gap is the main P1 issue. Cursor also states that ACP mode reads project/user `.cursor/mcp.json`, while team-dashboard MCP configuration is not supported there; the preset should not imply that generic per-session MCP parity covers every Cursor MCP source.

Cursor publishes native Windows artifacts in the registry, while Cognia lists macOS/Linux only. As with Kiro, this is acceptable only as an explicit sandbox restriction. The upstream CLI remains beta, so exact-version certification matters.

### DeepSeek Harness SDK and ACP

Cognia's transport split matches upstream semantics:

- SDK `session/prompt` is only an admission receipt; terminal completion arrives through session events/status. The local adapter waits for that terminal state.
- ACP is automation-only committed replies, with one-shot permission requests and prompt cancellation but no live reasoning/tool/progress presentation and no session load/list/resume.

See the pinned-source [SDK server README](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/server/README.md) and [ACP README](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/acp/acp/README.md).

The capability drift found during this audit is fixed in the current working tree: current DSH ACP can accept images only when the host composes a durable attachment store and the exact model supports them, while Cognia's `host.acp.yml` composes no attachment store. The `deepseek-harness-acp` preset now refines images to unsupported.

P1 catalog drift: Cognia deliberately pins a complete 0.1.0-rc.6 composition, while upstream is now 0.1.1-rc.2 and explicitly remains a breaking developer preview. Keeping rc.6 is reasonable; an automatic bump is not. Record rc.6 as the exact supported managed channel in the runtime catalog, then test rc.2 separately before migration. The [upstream repository](https://github.com/deepseek-ai/deepseek-harness) describes the preview status.

## A2A findings

The adapter's protocol negotiation is broadly current: it supports 0.3 and 1.0 JSON-RPC method names, sends `A2A-Version: 1.0`, discovers `/.well-known/agent-card.json` with a legacy fallback, chooses a declared JSON-RPC interface, streams updates, resubscribes after interruption, and falls back to task retrieval. A2A 1.0.1 and its bindings are documented in the [released specification](https://a2a-protocol.org/latest/specification/) and [1.0 announcement](https://a2a-protocol.org/latest/announcing-1.0/).

It should be described as an A2A JSON-RPC subset, not complete A2A 1.0 support. The first-turn `contextId` ownership bug found during this audit is fixed in the current working tree. The JSON-RPC request paths correctly retain `Content-Type: application/json`; `application/a2a+json` belongs to the HTTP+JSON/REST binding, not the JSON-RPC binding. Remaining P1 gaps are:

- Agent Card security schemes are not negotiated; configuration is limited to manually supplied bearer/basic headers.
- authenticated extended Agent Cards are not retrieved;
- signed Agent Cards are not verified;
- `input-required` and `auth-required` terminal states are flattened into text plus a successful-looking end-turn event instead of a structured, resumable interaction;
- file and data parts are flattened to text markers instead of attachments/structured data;
- gRPC and REST bindings are intentionally unsupported.

Discovery and security requirements are described in [A2A agent discovery](https://a2a-protocol.org/latest/topics/agent-discovery/) and the [A2A key concepts](https://a2a-protocol.org/latest/topics/key-concepts/). Recommended order: first preserve `input-required`/`auth-required` as explicit canonical events, then implement security-scheme negotiation and signed-card verification before promoting remote A2A beyond an advanced/custom integration.

## Recommended fix order

1. Smoke-test the already corrected Droid `acp-daemon` launch against initialize/new-session/prompt/cancel.
2. Demote optional generic ACP capability rows to live/unknown and remove or correctly name the unsupported `1.21.0` schema label.
3. Add Cursor blocking-extension handling; add Kiro extension handling or explicit partial-support notices.
4. Add exact runtime certification/distributions from the ACP Registry and remove the three relevant unpinned `npx` waivers.
5. Set the Pi RPC version range and certify 0.84.2; refine Pi ACP setup facts.
6. Represent the exact DSH rc.6 managed channel in the runtime catalog.
7. Preserve A2A interruption/auth states structurally and implement Agent Card security verification.
8. Make Windows withholding explicit for Kiro/Cursor.

## Minimum conformance gate

For each executable ACP preset and every newly certified version, run the same black-box fixture:

1. spawn and parse stdout without banner pollution;
2. initialize and record actual agent capabilities;
3. create a session with an MCP fixture and validate whether it is truly consumed;
4. prompt and verify streaming followed by one terminal response;
5. exercise permission allow/reject/cancel;
6. load/resume only when advertised;
7. send an image only when advertised and verify the agent receives it;
8. invoke one vendor-specific blocking extension where documented;
9. terminate and verify no child process remains.

Support tiers should be derived from this evidence: “documented-only,” “executable/unverified,” “certified exact version,” or “remote custom subset.” A preset being present and launchable is not, by itself, evidence of full protocol capability.
