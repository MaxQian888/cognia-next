# Tool execution topology in Cognia

Date: 2026-10-20 (Asia/Shanghai)

Scope: source inspection of the current working tree. No running installation,
user configuration, live connection, or confinement guarantee was tested. This
note extends the Lima feasibility research with a separate map of existing tool
execution; it does not propose or implement a backend change.

## Three separate locations

For each tool, distinguish:

1. The agent loop that receives the model's tool request.
2. The handler process that dispatches it.
3. The machine, filesystem, browser, desktop, or service the operation affects.

A remote agent loop can proxy a tool back to the originating client; that
client's handler can then call a remote Host again. Handler location alone is
not the action's location. Approval and path policy are separate from both.

## Tool families

| Family                                                                 | Dispatch / action location                                                                                    | Important boundary                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Sidecar core `bash`, file reads, searches, edits                       | Node sidecar's execution environment; the Claude Agent SDK also has native tools in its runtime               | Ordinary tools do not inherently enter the session's VM                        |
| `sandbox_bash`, `sandbox_edit`, `sandbox_write`, `sandbox_text_editor` | Session runtime routes to OS sandbox, Host pool, E2B workspace, or bound desktop                              | Requires a valid runtime binding and actual backend                            |
| External Agent native tools                                            | Runtime where the external Agent was placed, subject to its own native policy and Cognia's launcher/placement | Host-supplied ACP callbacks and MCP tools can reach elsewhere                  |
| Interactive terminal and workflow terminal nodes                       | Selected terminal Host; local PTY, remote WebSocket/WebRTC, or explicit terminal target                       | Independent from `SandboxSessionRuntime` routing                               |
| Computer Use                                                           | Current execution Host desktop, or the bound sandbox connection                                               | GUI target and shell tier are separate; `cua-desktop` binds both               |
| Browser automation                                                     | Selected browser engine: local Chromium, user Chrome, extension browser, remote browser, or embedded webview  | Neither project container selection nor GUI sandbox automatically relocates it |
| MCP stdio                                                              | Child process started in the MCP client's environment                                                         | No automatic inheritance of a chat VM binding                                  |
| MCP HTTP/SSE                                                           | Client sends protocol requests; endpoint server implements actions                                            | Its file paths belong to that server's environment                             |
| Cognia plugin and promoted tools                                       | Renderer, CLI, or headless brain handler, then implementation-specific RPC or API                             | Plugin registration is not an execution-machine declaration                    |
| Search and fetch                                                       | Current handler uses configured provider and platform network implementation                                  | Native provider tools and remote MCP may use different routes                  |
| Editor/UI, artifacts and session state                                 | Current controller or owning runtime; underlying editor/files backend may route further                       | Agent process can be remote while UI effects stay on the client                |
| `run_code` presentation                                                | Restricted child supervised by the sidecar; typed read-only tool proxies re-enter normal dispatch             | Not a general-purpose Linux VM                                                 |
| Workflow, Bot, schedule, team, skill                                   | Owning runtime orchestrates; each invoked tool follows its own route                                          | Trigger origin and skill instructions do not choose every action's machine     |

## Session sandbox behavior

`lib/claude/build-options.ts:4529` applies the headless Host placement before the
ordinary session/character/application sandbox ladder. A headless Host normally
forces `container`; an explicit project `hostProcess` opt-out returns to the
ordinary ladder. Pool availability remains a separate requirement.

At `build-options.ts:4646`, sandbox mode denies ordinary SDK Bash/Edit/Write and
sidecar core mutators/process escape hatches. It directs the model to the
`sandbox_*` tools. If the CLI supplies `builtinProcessSandbox` for the OS tier,
some built-in process tools remain and use the sandbox launcher instead.

Ordinary Read/Grep/Glob are not globally rewritten to the selected sandbox.
Core `read` uses Node filesystem APIs in its sidecar environment. The lite
confinement classifier allows ordinary out-of-root reads, escalates out-of-root
writes, and denies protected credential paths; this policy is not a VM.

Private scratch workspaces receive a stricter surface at
`build-options.ts:5502`: host readers/searches, LSP and other host tools are
withheld, and the prompt directs filesystem access through sandbox tools.

`lib/sandbox/session-runtime.ts:493` dispatches the four shell tiers. Missing
non-OS placement refuses the affected operation instead of running it on the
host. A failed binding can still allow the conversation to continue with the
unavailable surface recorded. This differs from project environment routing,
where an explicitly non-mandatory runtime may allow a recorded fallback.

## Deployment scenarios

| Scenario                               | Execution behavior                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop, local target, sandbox off     | Core tools and native processes operate in the local execution environment; UI tools use its renderer; actual OS permissions and tool policy still apply                |
| Desktop, OS sandbox on                 | Sandboxed commands still execute on that computer, under OS confinement; GUI can remain the real desktop                                                                |
| Desktop, E2B microVM                   | Bound sandbox tools execute in the claimed E2B workspace; a normal local cwd does not automatically create an E2B workspace; other tool families keep their routes      |
| Desktop, bound CUA desktop             | `cua-desktop` moves sandbox shell/file operations and GUI to that connection; terminal/browser/MCP remain independent                                                   |
| Desktop controlling remote Host        | Execution-class RPCs follow remote routing, but client data stays local and renderer-owned tool requests may return to this client                                      |
| Browser/mobile paired with Host        | Native execution is requested from Host; client-owned tools may run in the browser/mobile JS handler and route onward; not every Host has GUI or every feature          |
| Browser/mobile standalone              | Available JS/API tools can run on device; OS process, PTY and host filesystem require a backend and are withheld/refused when unavailable                               |
| Headless Host, Bot/schedule/phone work | Brain owns its tool dispatch; normal built-in task placement forces the project container runtime unless explicitly opted out; absent environment refuses sandbox calls |
| External Agent in project environment  | Native operations are relative to its process/container/provider; separately provided Cognia/MCP/ACP tools retain their own action routing                              |
| Standalone CLI                         | Installed Node process/file ports and sidecar execute on CLI machine; OS sandbox requires its registered helper and policy; remote MCP still runs at its endpoint       |

## Evidence and code navigation

- `lib/tauri/transport-instance.ts`: desktop routing transport, companion
  transport for mobile/paired browser, unsupported web stub, installed CLI host.
- `lib/tauri/transport-routing.ts:168`: only appropriate execution commands follow
  active remote; client commands and client data plane remain local.
- `lib/claude/controller-tool-proxy.ts:1` and
  `lib/claude/plugin-tool-dispatch-bridge.ts:41`: originating-device tool proxy.
- `components/providers/plugin-tool-dispatch-provider.tsx:29` and
  `lib/headless/runtimes/plugin-tool-dispatch.ts:5`: actual dispatch registration.
- `sidecar/src/tools/builtin/core-files/read.ts:68` and `bash.ts:338`: Node file
  reads and process launch in sidecar environment.
- `sidecar/src/policy/confinement/classify.ts:59`: lite path classification.
- `lib/sandbox/session-runtime.ts:165`: explicitly limited routing scope;
  `:418` GUI target; `:493` shell tier; `:938` OS backend selection.
- `lib/sandbox/host-task-placement.ts:43`: headless default and project opt-out.
- `lib/sandbox/container-exec-adapter.ts:1`: retained task environment execution.
- `lib/sandbox/host-agent-placement.ts:92`: external Agent placement on Host.
- `lib/ai/agent/external/host/process-host.ts:57`: shared process plane.
- `lib/ai/agent/external/host/file-host.ts:1`: ACP file callbacks use Host plane.
- `lib/ai/agent/external/session/renderer-tool-host.ts:1`: provided Cognia tools
  are separate from the external Agent's native tool bodies.
- `lib/terminal/pick-transport.ts:35`, `lib/terminal/headless-exec.ts:1`, and
  `lib/workflow/nodes/terminal/script.ts:1`: separate terminal transport/policy.
- `lib/browser-companion/host-transport.ts:25`: desktop extension connection
  intentionally uses this desktop's local transport, even under remote routing.
- `lib/browser/agent-engine.ts:1102`: browser engine resolution.
- `lib/mcp/transport.ts:202`: stdio child versus remote URL transports.
- `lib/claude/plugin-tool-ipc.ts:543` and `:692`: web network dependencies and
  Cognia tool dispatch.
- `lib/ai/chat/standalone-tools.ts:71`: device-only BYOK uses the shared handler.
- `lib/claude/editor-builtin-tools.ts:1`: editor context and mounted editor.
- `sidecar/src/tools/builtin/run-code/index.ts:1`: code presentation contract.

## Implication for Lima

Adding a Lima backend would relocate only operations actually routed through
that backend. A claim that an entire task stays inside one VM requires explicit
handling of native Agent tools, MCP, browser, terminal, file callbacks, network
tools and client-proxied operations. The present source does not provide one
global switch that relocates all these families together.

## Additional implementation-specific distinctions

- MCP HTTP is not necessarily a cloud service: a loopback HTTP tool server may
  run on the same Host. Claude Agent SDK MCP configuration is relayed through
  `sidecar/src/mcp/relay/sdk-servers.ts:47`; its stdio transport creates children
  at `sidecar/src/mcp/relay/index.ts:84`.
- Browser extension control uses the paired browser's device socket. The local
  Chromium engine uses `services/workspace-runtime/src/browser-service.mjs:568`
  to launch Playwright Chromium, or `:741` to attach through CDP. A headless
  browser service can run in another runtime; remote does not imply a VM.
- Plugin runtimes differ: frontend JavaScript evaluates in the renderer or an
  injected Node importer (`lib/plugin/core/loader.ts:309`); Node-target plugins
  use a launched child (`:385`, `lib/plugin/launcher/launchPluginJs.ts:206`).
  Canonical Python loading uses `plugin_python_load`
  (`lib/plugin/core/manager.ts:6849`) and the Rust-managed subprocess runtime
  (`crates/cognia-plugin-runtime/src/python/mod.rs:239`). WASM loading uses the
  native Wasmtime host; the ordinary Web/mobile loader returns an unavailable
  stub (`lib/plugin/core/wasm-loader.ts:48`, `:85`). These runtimes may still
  invoke APIs whose resource targets are elsewhere.
- Search/Reader handler ownership does not imply all content stays there:
  provider APIs, external Readers and optional summaries can introduce remote
  calls. The desktop Reader network path uses the Rust proxy, mobile can use
  native Capacitor HTTP, and plain Web uses browser fetch/CORS
  (`lib/claude/plugin-tool-ipc.ts:543`, `:620`).

Validation: read-only source trace plus whitespace inspection of this note.
No application tests, build, live Host probe or real tool execution ran.
