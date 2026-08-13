# Pi coding agent research and Cognia direction

> Research date: 2026-08-13  
> Scope: Pi from Earendil Works (`earendil-works/pi`), formerly
> `badlogic/pi-mono`; this is not the Inflection consumer assistant.  
> Sources: official Pi documentation, repository, package manifests, release
> notes, and the current Cognia integration. Community `pi-acp` documentation is
> used only to describe that bridge.

## Executive conclusion

Pi is not a model. It is an MIT-licensed TypeScript agent toolkit and minimal
terminal coding harness. Its strongest qualities are a clean provider/loop/UI
layer split, unusually broad model support, an embeddable SDK, a documented
JSONL RPC mode, tree-shaped sessions, and a powerful TypeScript extension
runtime.

Pi deliberately does **not** ship built-in MCP, subagents, plan mode, permission
prompts, or a sandbox. It is therefore closer to a kit for building a tailored
agent product than a governed, batteries-included coding assistant. That makes
it a useful runtime and design reference for Cognia, but not a replacement for
Cognia's permission, sandbox, MCP, plugin, multi-agent, and cross-device layers.

Cognia already exposes Pi through the community `pi-acp` bridge. That path is a
reasonable experimental compatibility route, but it loses Pi-native behavior
and does not give Cognia an enforceable pre-tool permission boundary. If Pi is
to become a first-class Cognia runtime, the recommended next step is a native
`pi --mode rpc` protocol adapter, launched inside Cognia's whole-process
sandbox and paired with a Cognia-owned Pi extension for approval/tool bridging.

## Identity, ownership, and maturity

- Pi moved from `badlogic/pi-mono` and the `@mariozechner/*` npm scope to
  `earendil-works/pi` and `@earendil-works/*` in 2026-05. Version `0.74.0` was
  the first release under the new package scope.
- The current release observed on 2026-08-13 is `v0.84.1`, published on
  2026-08-07. The repository was pushed again on 2026-08-12.
- `@earendil-works/pi-coding-agent@0.84.1` requires Node `>=22.19.0`.
- The project remains pre-1.0 and moves quickly. Production embedding should
  pin an exact compatible version and run a protocol conformance suite.

Sources: [migration announcement](https://pi.dev/news/2026/5/7/pi-has-a-new-home),
[v0.84.1 release](https://github.com/earendil-works/pi/releases/tag/v0.84.1),
[coding-agent package manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json).

## Architecture

Pi has a useful public layer boundary:

```text
Provider APIs
    ↓
@earendil-works/pi-ai
    provider adapters, auth, models, normalized messages/streaming/tools
    ↓
@earendil-works/pi-agent-core
    stateful agent loop, context transforms, tool execution, queues, events
    ↓
@earendil-works/pi-coding-agent
    sessions, compaction, resources, extensions, skills, CLI, SDK, JSONL RPC
    ↓
TUI / embedded Node application / subprocess client
```

Related packages include `pi-tui`, `pi-telemetry`, a SQLite session backend,
and newer `pi-protocol`, `pi-client`, and `pi-server` packages. The latter form
a transport-neutral, length-prefixed CBOR remote-session stack. The official
server README explicitly labels it experimental and clarifies that it is a
library, not a standalone hosted coding-agent service. It is promising, but it
is not yet a production integration target for Cognia.

Sources: [repository packages](https://github.com/earendil-works/pi/tree/main/packages),
[agent core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md),
[remote client](https://github.com/earendil-works/pi/blob/main/packages/client/README.md),
[experimental server](https://github.com/earendil-works/pi/blob/main/packages/server/README.md).

## Agent loop and context model

The generic loop keeps application messages richer than provider messages:

```text
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → LLM Message[]
```

This makes pruning, compaction, external-context injection, and filtering of
UI-only messages explicit. The event lifecycle covers agent, turn, message,
tool execution, queue, compaction, retry, and settlement events.

Tool execution is parallel by default. Preflight runs before execution, allowed
calls may run concurrently, completion events follow actual completion order,
and durable tool results are emitted in the assistant's original call order.
Individual tools can force a whole batch to execute sequentially.
`beforeToolCall` can block a call; `afterToolCall` can transform its result.

Steering and follow-up are separate queues. Steering is delivered after the
current assistant turn and tool batch, before the next model call. Follow-ups
run only when normal tool and steering work is exhausted. This is a clearer
contract than treating every mid-run message as an undifferentiated append.

Sources: [agent core concepts and event flow](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#core-concepts),
[steering and follow-up](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#steering-and-follow-up).

## Providers, extensions, and sessions

Pi supports a broad provider catalog, including OpenAI, OpenAI Codex OAuth,
Anthropic, Google/Vertex, Azure OpenAI, Bedrock, DeepSeek, Mistral, Groq,
Cerebras, xAI, OpenRouter, Vercel AI Gateway, Cloudflare, Hugging Face,
Together, MiniMax, ZAI, Kimi, Xiaomi, and local/OpenAI-compatible endpoints.
Its provider layer also normalizes cross-provider conversation handoff.

TypeScript extensions can register or replace tools, intercept lifecycle and
tool events, add commands and providers, customize compaction, add TUI, perform
remote execution, and persist custom session entries. Skills use progressive
disclosure, and Pi packages bundle extensions, skills, prompts, and themes.
This power comes with full process authority: extensions and installed package
code are not isolated.

Sessions are append-only JSONL trees rather than flat transcripts. Entry
`id`/`parentId` relationships support in-place branching, tree navigation,
fork/clone, labels, compaction checkpoints, branch summaries, model changes,
and extension-owned entries.

Sources: [providers](https://pi.dev/docs/latest/providers),
[extensions](https://pi.dev/docs/latest/extensions),
[skills](https://pi.dev/docs/latest/skills),
[packages](https://pi.dev/docs/latest/packages),
[sessions](https://pi.dev/docs/latest/sessions),
[session format](https://pi.dev/docs/latest/session-format).

## Embedding surfaces

Pi offers three relevant integration levels:

| Surface                                   | Best use                                                   | Tradeoff                                                                             |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pi-agent-core` / coding-agent SDK        | Same-process Node product with deep customization          | Tight package/API coupling and shared process authority                              |
| `pi --mode rpc`                           | IDE, desktop app, or cross-language subprocess integration | JSONL protocol needs compatibility management; Pi remains the session/tool authority |
| `pi-protocol` + `pi-client` + `pi-server` | Future multi-session remote transport                      | Server is explicitly experimental and not a ready coding-agent daemon                |

The RPC protocol uses strict LF-delimited JSONL. Generic line readers that also
split Unicode line separators are not protocol-compliant. It exposes prompting,
steering/follow-up, abort, state/messages, model and thinking controls,
compaction, retry, bash, session fork/clone/tree/entries, commands, streamed
events, and an extension UI request/response subprotocol.

Sources: [SDK](https://pi.dev/docs/latest/sdk),
[RPC](https://pi.dev/docs/latest/rpc),
[JSON event stream](https://pi.dev/docs/latest/json).

## Security boundary

Pi's project trust controls whether project-local settings, extensions, skills,
prompts, themes, and packages are loaded. Official documentation is explicit
that this is **not** a sandbox and does not restrict what tools can do after Pi
starts. Pi runs with the launching user's filesystem, process, network, and
credential permissions.

The official containment guidance is to isolate the whole Pi process with a
container, VM, Gondolin, or OpenShell, or to route tools into an isolated
environment. Tool-only routing is incomplete when other extensions still run on
the host, so Cognia should prefer whole-process isolation.

Sources: [security](https://pi.dev/docs/latest/security),
[containerization](https://pi.dev/docs/latest/containerization),
[Pi philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy).

## Current Cognia integration

Cognia currently defines Pi as an executable external-agent preset using:

```text
Cognia ACP client → npx -y pi-acp → pi --mode rpc → Pi runtime
```

The preset is correctly tagged `community-adapter` and `experimental` in
`lib/ai/agent/external/ecosystem-adapters.ts`. The community bridge documents
the following material limitations:

- no ACP filesystem or terminal delegation; Pi executes locally;
- MCP configuration is accepted but not wired to Pi;
- assistant thinking is not emitted as a separate stream;
- extension-provided slash commands are not supported;
- the adapter is MVP-style, may have minor breaking changes, and is centered on
  Zed compatibility.

Because Pi itself has no built-in approval handshake and `pi-acp` does not
delegate filesystem/terminal execution, Cognia's generic ACP permission mode
must not be presented as an enforceable pre-tool security boundary for this
preset. This conclusion is an inference from the two projects' documented
boundaries, not a claim that the bridge is malicious.

Sources: [Cognia preset](../../lib/ai/agent/external/ecosystem-adapters.ts),
[pi-acp README](https://github.com/svkozak/pi-acp).

## Recommended Cognia direction

### Short term: keep but harden the compatibility route

1. Keep `pi-acp` visibly experimental and disclose that Cognia permissions/MCP
   are not fully projected into Pi.
2. Do not rely on an unpinned `npx -y` fetch for a privileged runtime. Require a
   locally installed, supported bridge or ship a reviewed pinned artifact.
3. Detect and display both Pi and `pi-acp` versions, and reject unsupported
   combinations rather than silently degrading.
4. Run the entire process chain inside Cognia's workspace sandbox.

### Medium term: add a native `pi-rpc` adapter

Launch `pi --mode rpc` directly and normalize Pi events into Cognia's existing
`ProtocolAdapter` contract. Preserve native Pi controls for steering,
follow-ups, thinking level, compaction, tree navigation, fork/clone, extension
UI, retries, and session metadata.

The adapter should also:

- use a strict LF JSONL codec and bounded input/output queues;
- persist Pi session identity as provider-session metadata while keeping
  Cognia's canonical transcript as the product record;
- perform explicit version/capability negotiation owned by Cognia;
- map Pi extension UI requests into Cognia's elicitation UI;
- ship a reviewed Cognia Pi extension that intercepts tool calls for approval
  and bridges approved Cognia/MCP tools where practical;
- place the whole Pi process under Cognia's sandbox ceiling so a missing or
  bypassed extension cannot escape policy;
- pass all outbound prompts/provider-bound context through Cognia's PII gate or
  clearly declare Pi-managed provider calls as a separate trust path.

### Long term: evaluate SDK hosting only for deeper tool parity

Embedding `@earendil-works/pi-coding-agent` in a dedicated Node worker would
make Cognia-native tools and lifecycle interception easier, but it creates
tighter dependency coupling and another credential/session authority. Do this
only if native RPC plus a bridge extension cannot provide the required product
surface. Do not import the SDK into the static-export frontend.

## Design lessons for Cognia

Worth adopting or strengthening:

1. Keep provider normalization, generic agent loop, product orchestration, and
   UI/transport as explicit layers.
2. Use a two-stage context boundary so rich application messages are converted
   deterministically into the exact provider-visible context after PII policy.
3. Treat lifecycle events and final snapshots as contracts; streaming deltas
   are presentation hints, not the sole durable truth.
4. Preserve source order when persisting parallel tool results.
5. Model steering and follow-up as distinct queues.
6. Keep append-only branch and compaction records instead of destructively
   rewriting history.
7. Provide tool schema migration hooks similar to Pi's argument preparation for
   resumed sessions.
8. Preserve Agent Skills interoperability and progressive disclosure.

Do not copy:

1. Pi's no-permissions/no-sandbox default.
2. Arbitrary extension code sharing full authority with built-in tools.
3. Pi-owned global auth and session files as Cognia's canonical product state.
4. A loose dependency on moving `0.x` APIs or the experimental remote server.

## Decision

- **Use Pi today:** yes, as an explicitly experimental external agent.
- **Replace Cognia's runtime with Pi:** no.
- **Build a native adapter:** yes, if Pi is a strategic supported runtime rather
  than a catalog checkbox.
- **Best integration boundary:** subprocess RPC plus Cognia-owned sandbox,
  permission extension, PII policy, and canonical session projection.
