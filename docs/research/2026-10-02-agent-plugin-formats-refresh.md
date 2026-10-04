# Agent plugin formats refresh

Research snapshot: 2026-10-02. Follow-up to `2026-09-20-agent-plugin-platform-differences.md`. It records the
vendor documentation the plugin converter (`lib/plugin/convert/`) was aligned with, and the decisions taken
where the documentation was ambiguous. No native host was installed or run; every conversion still reports
`hostVerified: false`.

## Sources and versions

| Ecosystem             | Source                                                                                                                          | Version / status                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Agent Plugins         | github.com/agentplugins/agent-plugins-spec                                                                                      | 1.0.0 Published; 1.1.0 Working Draft (identical text apart from version strings) |
| GitHub Copilot CLI    | docs.github.com/en/copilot/reference/cli-plugin-reference, …/hooks-reference                                                    | current docs; Agent Plugins 1.0.0/1.1.0 or legacy manifest                       |
| Cursor                | cursor.com/docs/reference/plugins, cursor.com/docs/agent/hooks                                                                  | current docs                                                                     |
| Kimi CLI              | github.com/MoonshotAI/kimi-cli `docs/en/customization/plugins.md`                                                               | 1.52.0, plugins in Beta                                                          |
| Devin                 | docs.devin.ai/cli/extensibility/plugins/overview                                                                                | closed beta                                                                      |
| OpenCode              | opencode.ai/docs (repo anomalyco/opencode)                                                                                      | 1.18.34                                                                          |
| Claude Code           | code.claude.com/docs/en/plugins-reference                                                                                       | as of v2.1.283                                                                   |
| Codex                 | openai/codex `codex-rs/core-plugins`                                                                                            | rust-v0.160.0 (2026-10-01)                                                       |
| Gemini CLI            | `docs/extensions/reference.md`                                                                                                  | v0.62.0                                                                          |
| Pi                    | github.com/earendil-works/pi `packages/coding-agent/docs/packages.md`, `src/core/package-manager.ts`, `src/core/pi-manifest.ts` | `@earendil-works/pi-coding-agent` 1.0.0                                          |
| Factory Droid         | docs.factory.ai/harness/plugins, docs.factory.ai/reference/hooks-reference                                                      | current docs                                                                     |
| Qoder CLI             | docs.qoder.com/cli/plugins, docs.qoder.com/cli/hooks                                                                            | current docs                                                                     |
| CodeBuddy             | codebuddy.ai/docs/cli/plugins-reference, codebuddy.ai/docs/cli/hooks                                                            | current docs                                                                     |
| Auggie                | docs.augmentcode.com/cli/plugins, docs.augmentcode.com/cli/hooks                                                                | current docs                                                                     |
| Open Plugins (legacy) | docs.openhands.dev/sdk/guides/plugins and …/hooks; Copilot legacy `.plugin/`                                                    | OpenHands SDK docs                                                               |

## What changed in the converter

- Five ecosystems were added: `factory-droid`, `qoder`, `codebuddy`, `auggie`, `open-plugins`. Claude-family
  layouts share one reader and one projection driven by profiles in `claude-family.ts`.
- Hooks convert through explicit per-host event maps (`hook-dialects.ts`). Gemini, Codex, Cursor, Droid, Qoder,
  CodeBuddy, Auggie and OpenHands hooks now import and export where an event has a 1:1 equivalent.
- Detection (`bundle-detection.ts`) prefers the most specific vendor manifest and reports shadowed manifests.
- Kimi's manifest is a root `plugin.json`. The earlier `kimi.plugin.json` / `.kimi-plugin/` names came from
  the 2026-09-20 snapshot of a different repository (`kimi-code`) and are not read by Kimi CLI 1.52.0.
- Pi is a full bidirectional converter (`pi-package.ts`) that retains the whole package as one `piPackages`
  entry and mirrors Pi's own resource discovery (manifest entries, globs, `!`/`+`/`-` overrides, conventional
  directories).
- Agent Plugins accepts 1.0.0 and 1.1.0 (export writes 1.0.0), reports unknown top-level fields as ignored,
  enforces the `mcp.json` schema/version, `cwd` and expansion rules, and reads the `dev.openhands/` and
  `com.github.copilot/` client namespaces.

## Decisions where the documentation was ambiguous

- **Pi package location.** The package is retained in place (`path: "."`) rather than under a `pi-package/`
  subdirectory: the GitHub and Load-unpacked installers copy the source tree and may only overlay
  `plugin.json` and `dist/index.js` (`crates/cognia-plugin-runtime/src/generated_files.rs`), so relocated bytes
  could never be installed. A package that already uses `dist/index.js` is blocked.
- **Copilot hooks stay blocking.** Copilot's hook file is versioned (`version: 1`) with flat
  `bash`/`powershell`/`command` entries, a 30 s default timeout and fail-closed `preToolUse` on any non-zero
  exit; Cognia user hooks fail open. No exact mapping exists in either direction.
- **Tool vocabularies.** Hosts whose tool events report their own tool names cannot carry a non-wildcard
  matcher; wildcard matchers convert with a review warning.
- **Cursor rules block.** `alwaysApply`/`globs` rules apply automatically; a contextual Cognia skill would only
  load on demand.
- **Kimi detection.** A root `plugin.json` is Kimi's only when it carries `tools`, `inject` or `config_file`;
  Kimi export always writes `tools: []` so the result is detected unambiguously.
- **Open Plugins agents.** Copilot reads `*.agent.md`, OpenHands reads `<name>.md`; agent export to the legacy
  `.plugin/` layout blocks and points at the `agent-plugins` (`dev.openhands/`) or `copilot` targets.
- **Devin agents and hooks stay blocking.** Plugin subagents load only in local Devin agents and plugin hooks
  run best-effort in local sessions; Cognia would run them on every surface.
- **OpenCode remote MCP stays blocking.** OpenCode falls back from streamable HTTP to SSE and negotiates OAuth
  automatically.
- **Claude `bin/` and `./` paths are warnings.** The bytes convert; only bare-name PATH lookup and Claude's own
  manifest validation differ.

## Evidence limits

Documentation was fetched as HTML/Markdown on 2026-10-02 and summarized; no plugin was installed in any host.
Event lists for Factory Droid, Qoder, CodeBuddy and Auggie come from their hooks pages and may grow; an event
missing from a dialect blocks rather than converts.
