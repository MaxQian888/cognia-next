# Codex CLI as a web-search subagent for Claude Code

Research date: 2026-08-30

## Executive conclusion

Yes. There is now a mature, first-party path: OpenAI's official [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) plugin installs a Codex-backed Claude Code subagent and delegates through the supported Codex App Server. OpenAI's own CLI documentation explicitly tells Claude Code users to use this plugin and marks the older `codex mcp-server` interface as deprecated ([Codex CLI command reference](https://developers.openai.com/codex/cli/reference/), [deprecated MCP-server guide](https://developers.openai.com/codex/guides/agents-sdk/)).

The recommended path is therefore:

1. Adopt the official plugin rather than build a general Claude/Codex bridge.
2. Enable Codex live search with `web_search = "live"`.
3. Add only a thin, search-specific Claude Code agent or skill if a stable `web-researcher` persona is required.

Do not start by writing a new MCP server. Build a custom wrapper only if the required contract is a strict, machine-oriented `search(query) -> cited synthesis` tool rather than a general Codex subagent.

## What is supported by the two products

Claude Code custom subagents run in their own context window and can be restricted to named tools, permissions, skills, hooks, and MCP servers. They can also run in the background. This is a natural fit for keeping search logs and source-reading out of the main context ([Claude Code subagents](https://code.claude.com/docs/en/sub-agents)). Claude Code can connect to local stdio MCP servers and can scope them locally, per project, or per user; project MCP configuration requires an explicit trust decision ([Claude Code MCP](https://code.claude.com/docs/en/mcp)).

Codex exposes two current integration surfaces relevant here:

- `codex exec` is the supported non-interactive interface. It supports explicit sandboxing, JSONL events, structured output schemas, and emits web searches as event items ([Codex non-interactive mode](https://learn.chatgpt.com/codex/non-interactive-mode)).
- Codex App Server is the supported deep-integration protocol for authentication, conversation history, approvals, and streamed events ([Codex App Server](https://developers.openai.com/codex/app-server)).

For web access, `codex --search` enables live search for one CLI run. Local Codex otherwise defaults to cached search; `web_search = "live"` selects live retrieval persistently. The hosted web-search tool is separate from sandboxed shell networking, and search-domain filters do not constrain shell, MCP, connector, or app traffic ([Codex web search](https://developers.openai.com/codex/web-search), [Codex configuration reference](https://developers.openai.com/codex/config-reference)).

## Candidate assessment

| Candidate                                                                                           | Architecture                                                              | Search fit                                                   | Maturity as of 2026-08-30                                                                                                                                                                                                | Decision                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)                               | Claude Code plugin/subagent -> local Node companion -> `codex app-server` | General Codex delegation; search follows Codex configuration | First-party, v1.0.6, 32,541 stars, 2,249 forks; latest release 2026-07-08 ([GitHub API](https://api.github.com/repos/openai/codex-plugin-cc), [release](https://github.com/openai/codex-plugin-cc/releases/tag/v1.0.6))  | **Adopt**                                            |
| [`hampsterx/codex-mcp-bridge`](https://github.com/hampsterx/codex-mcp-bridge)                       | Claude Code MCP -> Node subprocess wrapper -> `codex --search exec`       | Dedicated `search` tool with cited synthesis                 | v0.9.1; active commit on 2026-08-29, but only 3 stars and no forks ([GitHub API](https://api.github.com/repos/hampsterx/codex-mcp-bridge), [release](https://github.com/hampsterx/codex-mcp-bridge/releases/tag/v0.9.1)) | **Pilot only if a strict MCP search tool is needed** |
| [`Dunqing/claude-codex-bridge`](https://github.com/Dunqing/claude-codex-bridge)                     | Bidirectional MCP wrappers around both CLIs                               | Much broader than search                                     | 7 stars, 2 forks, no declared license, last push 2026-02-11 ([GitHub API](https://api.github.com/repos/Dunqing/claude-codex-bridge))                                                                                     | Do not adopt                                         |
| [`pathcosmos/codex-on-claude`](https://github.com/pathcosmos/codex-on-claude)                       | MCP, installed skills/agent/hooks, usage heuristics                       | General delegation                                           | 1 star, no forks, last push 2026-05-29; documentation expects a Codex MCP server ([GitHub API](https://api.github.com/repos/pathcosmos/codex-on-claude))                                                                 | Do not adopt over first-party plugin                 |
| [`buchmark/codex-bridge-for-claude-code`](https://github.com/buchmark/codex-bridge-for-claude-code) | Claude subagent -> `codex mcp-server`                                     | General delegation                                           | 2 stars, no forks; depends on the deprecated Codex MCP-server path ([GitHub API](https://api.github.com/repos/buchmark/codex-bridge-for-claude-code))                                                                    | Do not adopt                                         |
| [`xiaocang/claude-codex-bridge`](https://github.com/xiaocang/claude-codex-bridge)                   | Python/FastMCP -> Codex CLI                                               | General delegation                                           | 7 stars, no forks, last push 2025-09-17 ([GitHub API](https://api.github.com/repos/xiaocang/claude-codex-bridge))                                                                                                        | Do not adopt                                         |

GitHub stars are an adoption signal, not a security or quality guarantee. Here they are useful mainly because the first-party option is also the officially documented migration target.

## Option A: official OpenAI plugin

### Installation

The official repository documents this Claude Code flow ([README at v1.0.6](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md)):

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

It installs `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, job-management commands, and a `codex:codex-rescue` subagent. The runtime uses the machine's existing Codex installation, authentication, and `~/.codex/config.toml` / trusted project `.codex/config.toml` configuration ([official plugin README](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md#codex-integration)).

To make delegated research use current results, configure Codex:

```toml
# ~/.codex/config.toml, or a trusted project's .codex/config.toml
web_search = "live"

# Optional: restrict hosted search results to approved source domains.
# [tools.web_search]
# allowed_domains = ["docs.example.com", "github.com"]
```

Then invoke a clearly read-only research task, for example:

```text
/codex:rescue --background Research the current options for <topic>.
Use live web search, prefer primary sources, include source URLs, and do not edit files.
```

### Why this is the default choice

- OpenAI owns both the plugin and the Codex runtime interface.
- It uses App Server, the supported replacement for `codex mcp-server`.
- It already handles background jobs, cancellation, result retrieval, thread continuation, authentication checks, and output routing.
- The shipped subagent is a thin forwarding wrapper with only `Bash`; research requests are sent through a read-only sandbox. The source defaults other substantial rescue tasks to write-capable mode, so the search-specific prompt must explicitly say “research” and “do not edit” ([`codex-rescue.md`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/agents/codex-rescue.md)).
- The companion starts App Server threads with `approvalPolicy: "never"` and a read-only sandbox unless write access was explicitly selected ([runtime source](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/codex.mjs#L60-L83)).

### Limitations

- It is a general Codex delegation plugin, not a single-purpose `search(query)` API.
- The plugin does not expose a per-call `--search` switch. Based on its task source, it passes prompt/model/effort/sandbox into App Server and relies on the inherited Codex configuration for web-search mode ([task runtime](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/codex-companion.mjs#L458-L509)). This is an inference from the pinned source and official statement that the plugin applies normal Codex configuration.
- Cached search is the default. “联网” that truly requires the latest page state must explicitly select `web_search = "live"`.
- Plugin installation adds executable local code and hooks. Keep the plugin pinned/updated from the OpenAI marketplace and do not enable its optional review gate for a search-only workflow; the repository warns that the gate may create long-running loops and consume usage quickly ([official plugin README](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md#enabling-review-gate)).

## Option B: dedicated community MCP search tool

`hampsterx/codex-mcp-bridge` is the closest existing implementation to the exact requested shape. It registers an MCP `search` tool and launches:

```text
codex --search exec --sandbox read-only ...
```

Its implementation forces `--search` before `exec`, pipes the prompt over stdin, pins the sandbox to read-only, applies a hard timeout, and parses the final output ([search implementation at commit `7836130`](https://github.com/hampsterx/codex-mcp-bridge/blob/78361301c693e312ddf67223a8fd339d786f5ac8/src/tools/search.ts)). The project also documents `shell: false`, an environment-variable allowlist, path checks, secret redaction, process-group termination, concurrency limits, and protections against CLI argument/config injection ([security model](https://github.com/hampsterx/codex-mcp-bridge/blob/78361301c693e312ddf67223a8fd339d786f5ac8/SECURITY.md)).

Claude Code installation is one line ([project README](https://github.com/hampsterx/codex-mcp-bridge/blob/78361301c693e312ddf67223a8fd339d786f5ac8/README.md)):

```bash
claude mcp add codex-bridge -- npx -y codex-mcp-bridge
```

This option is architecturally cleaner for a strict search-tool contract, but it is not ecosystem-mature: it is a small third-party project with very low adoption. Anthropic explicitly states that it does not security-audit or manage arbitrary MCP servers and recommends using only trusted providers ([Claude Code security](https://code.claude.com/docs/en/security)). If piloted, pin the exact package version instead of `npx -y ...@latest`, use local rather than project scope initially, audit the installed dependency graph, and keep the tool read-only.

## Why not wire `codex mcp-server` directly

This used to be the shortest integration:

```bash
claude mcp add codex -- codex mcp-server
```

It is no longer the forward-compatible choice. OpenAI marks `codex mcp-server` deprecated and directly recommends the official Claude Code plugin, which uses App Server instead ([CLI reference](https://developers.openai.com/codex/cli/reference/), [MCP-server guide](https://developers.openai.com/codex/guides/agents-sdk/)). Existing bridges built around `codex mcp-server` may continue to work temporarily, but adopting one creates a known migration task.

## Security and operational requirements

Regardless of the chosen route:

1. **Treat search results as untrusted input.** OpenAI states this explicitly; cached search only lowers prompt-injection risk, it does not remove it ([Codex web search](https://developers.openai.com/codex/web-search)). The research prompt should require source comparison and prohibit following instructions found in retrieved pages.
2. **Keep filesystem access read-only.** `codex exec` defaults to read-only, and broader access should be used only in controlled environments ([Codex non-interactive mode](https://learn.chatgpt.com/codex/non-interactive-mode)).
3. **Separate hosted search from shell networking.** `web_search` and `tools.web_search.allowed_domains` govern the hosted search tool only; they do not constrain shell, MCP, connector, or app traffic ([Codex web search](https://developers.openai.com/codex/web-search)).
4. **Protect authentication material.** Codex reuses local CLI authentication. `~/.codex/auth.json` is password-equivalent, and API keys should not be exposed to repository-controlled processes ([Codex non-interactive mode](https://learn.chatgpt.com/codex/non-interactive-mode)).
5. **Bound output and runtime.** Claude Code warns at 10,000 MCP-output tokens and defaults to a 25,000-token maximum for tools that do not declare a limit ([Claude Code MCP](https://code.claude.com/docs/en/mcp)). A search wrapper should enforce a smaller synthesis budget, hard timeout, and cancellation.
6. **Require URL citations, not just prose claims.** `codex exec --json` exposes web-search items, which can be retained for auditing rather than trusting only the synthesized final answer ([Codex non-interactive mode](https://learn.chatgpt.com/codex/non-interactive-mode)).

## Build-versus-adopt recommendation

### Adopt now

Use `openai/codex-plugin-cc` plus live-search configuration. It is the only option that is simultaneously first-party, explicitly recommended by the Codex docs, based on the supported App Server, and already packaged as a Claude Code subagent workflow.

### Add a thin wrapper, not a new bridge

If users should be able to say “use the Codex web researcher,” add a small Claude Code agent/skill whose only responsibility is to forward a read-only, citation-constrained research prompt to the official plugin. Claude Code already provides the isolated context and background execution semantics; duplicating job management or transport adds little value.

### Pilot the community MCP only for a stricter API

Use `hampsterx/codex-mcp-bridge` only if downstream consumers require a named `search` MCP tool, explicit query parameters, response-length controls, or non-Claude MCP clients. Pin and audit it before team rollout.

### Build custom only when the contract cannot be met

A custom wrapper is justified if all of the following are required: per-call live/cached selection, organization-specific domain policies, normalized citation objects, deterministic JSON Schema output, centralized concurrency/rate limits, and audit logging. In that case, build on `codex exec --json` or App Server—not `codex mcp-server`—and reuse Claude Code's custom-subagent boundary rather than inventing another agent protocol.

## Suggested acceptance test for a pilot

1. Ask for a fact that changed within the last 24 hours and confirm a web-search event was emitted.
2. Verify every material claim has a direct source URL and that two independent primary sources are used where practical.
3. Run in a dirty test repository and confirm `git status --short` is unchanged.
4. Include adversarial instructions in a fetched fixture page and confirm the agent reports but does not follow them.
5. Confirm timeout, cancellation, and quota-exhaustion behavior.
6. Inspect logs and returned payloads for API keys, access tokens, home paths, and unrelated environment variables.
7. Run concurrent searches and verify queueing and output-size limits.
