# @cognia/agent-continue

Continue CLI 1.5.47 integration for Cognia's ADR-0217 process/file ports. The dedicated package keeps Continue's one-shot, model-generated JSON contract separate from ACP and persistent native servers.

`ContinueAdapter` takes `processHost`, `fileHost`, `outboundGate`, `redactDiagnostic` and optional `resolveLaunchEnvironment`. Each turn invokes `cn -p --format json --readonly`; explicit `bypassPermissions` uses `--auto`. Listeners are registered before spawn, stdout is bounded, and only a zero exit with valid JSON completes successfully. JSON properties such as `toolCalls` are model data, never fabricated native tool events.

Cognia stores a configuration/workspace-bound transcript in `.cognia/agent-sessions/continue-UUID.json` and replays it on resume. It does not use Continue's global `--resume` selection. Cancellation kills the turn process and works even if the host omits an exit notification. Prompt/file content and replayed history pass the required outbound gate.

This transport has no live token stream or per-tool approval channel. Mandatory native tool rules, per-tool allowlists, MCP injection, extra roots and unsupported permission modes are rejected. The hidden `cn serve` listener binds without authentication, so it is not used. Continue configuration/authentication remains upstream-owned (`CONTINUE_API_KEY` is supported by the CLI).

Contract sources: [pinned CLI](https://github.com/continuedev/continue/blob/d3f60ba9dd3fb5bfd3c91d6fbb41ce1aa768db45/extensions/cli/src/index.ts), [published JSON behavior tests](https://github.com/continuedev/continue/blob/d3f60ba9dd3fb5bfd3c91d6fbb41ce1aa768db45/extensions/cli/src/e2e/headless-json-format.test.ts).
