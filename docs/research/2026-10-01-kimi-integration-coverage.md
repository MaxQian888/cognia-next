# Kimi Code integration coverage audit

Follow-up: [implementation and verification results](2026-10-01-kimi-integration-completion.md). The findings below describe the audit baseline before that work.

Date: 2026-10-01. Scope: current Cognia source, installed `@moonshot-ai/kimi-code@2.1.1`, current official documentation, and the preceding authenticated acceptance run. This audit changes no runtime implementation or account state.

The native ACP execution and basic session lifecycle are integrated. Complete Kimi product coverage is not established: desktop authentication actions, native session deletion actions, managed installation, subscription quota, native extension management, and several TUI-only features remain outside the integration.

## Coverage matrix

| Feature                                    | Implementation                             | Evidence / remaining boundary                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI discovery and version policy           | Integrated                                 | Native 2.1.1 installed; archived Python 1.x rejected by version policy. Runtime remains uncertified.                                                                                                                                                                                     |
| Installation                               | Partial                                    | Exact npm installer in CLI/TUI and instructions in settings. Catalog is `system` owned with no managed distributions; lifecycle host refuses installation/removal of system-owned runtimes.                                                                                              |
| Upgrade, rollback, uninstall               | Partial                                    | Native `kimi upgrade` / package manager remain external. Cognia removes its agent configuration, not the system installation. No managed update/rollback pipeline for Kimi.                                                                                                              |
| Subscription login                         | Backend integrated; desktop action missing | Official `kimi login` succeeded. ACP terminal authentication and hook are implemented, but desktop components do not call `authenticate` or expose terminal auth state/cancel actions.                                                                                                   |
| Logout / account switching                 | Backend only                               | Manager/adapter expose ACP logout, but there is no desktop action or Kimi account selector. No real logout performed.                                                                                                                                                                    |
| Streamed text and thinking                 | Integrated                                 | Authenticated random-marker reply and thinking stream passed.                                                                                                                                                                                                                            |
| Model / thinking controls                  | Integrated                                 | Native model and thinking config options were selected successfully.                                                                                                                                                                                                                     |
| Images                                     | Integrated                                 | Authenticated model identified the attached red PNG.                                                                                                                                                                                                                                     |
| Resources / additional directories         | Shared ACP support                         | Text resource conversion and additional-root handling exist; no dedicated live Kimi acceptance. Native additional directories apply on session/new, not fork/load/resume.                                                                                                                |
| File tools / approval                      | Integrated                                 | Live scratch-file write/read and manual approval response passed. Denial, multi-choice Plan review, native shell reverse-RPC and elicitation have shared handling but no dedicated live Kimi acceptance.                                                                                 |
| Modes                                      | Integrated                                 | All Cognia canonical modes mapped and round-tripped. Non-bypass edit-only and deny-without-asking modes retain native manual approval. No complete live Plan workflow acceptance.                                                                                                        |
| Cancellation                               | Integrated                                 | Live in-flight turn returned `cancelled`.                                                                                                                                                                                                                                                |
| Session list/load/resume/close/fork/delete | Adapter integrated; desktop incomplete     | Native lifecycle smoke passed. Desktop has list/resume/fork, but no native-delete action in the external-agent hook/components.                                                                                                                                                          |
| stdio MCP                                  | Integrated for new/restored sessions       | Live tool receipt passed. Fork continuity has a reproduced gap; see below.                                                                                                                                                                                                               |
| HTTP/SSE MCP                               | Shared forwarding                          | Declared by native capabilities and supported by shared ACP conversion. No live Kimi HTTP/SSE acceptance.                                                                                                                                                                                |
| Slash commands / Skills                    | Partial, native discovery reused           | Native ACP handles builtin commands and discovered Skills; shared command component is mounted. Account-free probes passed `/help`, `/status`, `/usage`, `/tasks`, `/mcp`. `/compact` is advertised and handled by shared compaction routing but has no live Kimi compaction acceptance. |
| Token/context usage and subscription quota | Partial                                    | ACP context occupancy is consumed; `/usage` reports session tokens. Native ACP usage updates omit billing cost and subscription remaining/reset information. Existing provider quota code is not bound to Kimi CLI OAuth.                                                                |
| Plugins / custom agents / hooks            | Native configuration only                  | Native CLI can discover its configured extensions, but no Kimi management UI, deployment mapping or live extension acceptance was added. Existing Kimi bundle conversion is separate; ecosystem runtime entry has `pluginEcosystem: null`.                                               |
| TUI Goal / Swarm / Undo                    | Unavailable through current ACP            | Installed 2.1.1 returned `Unknown ACP command` for `/goal status`, `/swarm on`, `/undo 1`.                                                                                                                                                                                               |
| Native plugin management commands          | Unavailable through current ACP            | Installed 2.1.1 returned `Unknown ACP command` for `/plugins list`. Native TUI plugin management cannot be inferred from ACP Skills support.                                                                                                                                             |
| Native export/migration/web/remote control | Not integrated                             | No Cognia Kimi-specific export, legacy migration, web service or remote-control adapter.                                                                                                                                                                                                 |
| Audio / providers / NES / document sync    | Upstream ACP limitations                   | Audio is not advertised; upstream documents providers, NES, document methods and elicitation completion as unimplemented.                                                                                                                                                                |
| Desktop / packaged application acceptance  | Pending                                    | Component tests exist, but no manual desktop or packaged-build acceptance. Scoped TypeScript still encounters the two pre-existing publication-lifecycle argument errors.                                                                                                                |

## Reproduced fork MCP gap

An account-free test ran the installed CLI through Cognia's native macOS sandbox with a dedicated scratch state root, synthetic model credentials pointing to an unreachable loopback endpoint, and a local MCP fixture. No model prompt or user's subscription credentials were used.

1. `session/new` with the fixture MCP server: `/mcp` returned `probe (stdio): connected, 1 tools`.
2. `session/fork`, including the same `mcpServers` request: `/mcp` returned `No MCP servers configured for this session.`
3. Closing and loading that fork with explicit `mcpServers` produced a visible pending MCP entry; connection completion/tool invocation after rebinding was not asserted.

Kimi's fork implementation ignores supplied `mcpServers`. Cognia's generic `forkSession` returns the new session without a Kimi-specific restore/rebind step. The earlier smoke validated fork creation and deletion, not tool execution in the fork. This is a functional coverage gap, not merely missing tests.

## Priorities

1. Restore freshly authorized per-session MCP bindings after a Kimi fork and verify tool execution in the fork, including Cognia's own tool host.
2. Mount existing terminal authentication controls in the desktop UI and expose native session deletion through the hook/UI.
3. Complete shell, elicitation, Plan/deny, additional-directory, compaction and HTTP/SSE acceptance, then verify the real desktop flow.
4. Extend installation/update management, subscription quota and native plugin/Skill/agent/hook management with explicit ownership and supported upstream APIs.
5. Research official CLI / Server API alternatives for TUI-only Goal, Swarm, Undo and export. Sending unsupported TUI slash commands through ACP is not an implementation.

## Evidence pointers

- `scripts/smoke/kimi-acp-smoke.ts`: authenticated and account-free execution/lifecycle acceptance.
- `hooks/agent/use-external-agent.ts`: terminal authentication hooks; no native delete hook.
- `components/agent/external-agent/manager.tsx`: current hook consumption and mounted command/config/plan controls; no terminal-auth actions.
- `lib/ai/agent/external/manager.ts`: backend authentication/logout/delete/fork operations.
- `lib/ai/agent/external/lifecycle/runtime-host.ts`: `requireManaged` ownership boundary.
- `protocol/external-agent-runtimes.json`: Kimi system ownership, version range and empty distributions.
- `lib/agent-ecosystem/catalog.ts`: no Kimi portable history or plugin-runtime link.
- `/tmp/cognia-kimi-research/coverage-commands.json`: pinned native command probe results.
- `/tmp/cognia-kimi-research/coverage-fork-mcp.json`: pinned native fork MCP reproduction.

Sources: [official ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html), [CLI command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html), [slash commands](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html), [plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html), [Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html).
