# DeepSeek Harness development plugin shortlist

Research date: 2026-10-04 (Asia/Shanghai). Target: macOS Apple Silicon, Next.js/React/TypeScript and Rust/Tauri, DeepSeek Harness `0.2.0-rc.2`.

Implementation status: see [the applied setup report](2026-10-04-deepseek-harness-plugin-setup.md) for what was subsequently installed and tested.

This research section is a proposal for user confirmation. No plugin was installed or configured by this research. Compatibility below means published package/source evidence, not a successful local integration test. A new dated note is appropriate because this assesses the user's current standalone Harness setup, rather than Cognia's integration implementation.

## Recommendation

Start with the existing skill loader, official LSP, Context7, DeepWiki, Playwright, and local task notifications. The official MCP client is shared infrastructure for three of those capabilities. Add the TUI if terminal use is wanted. Keep Chrome DevTools, GitHub MCP, cost monitoring, and plugin marketplace optional. Avoid simultaneously enabling multiple browser controllers, multiple MCP bridges, or multiple cost meters by default.

Existing `~/.agents/skills` and project `.agents/skills` are already default discovery roots of the released official skill loader. There is no need to duplicate the existing workflow skills into another plugin bundle. The released `dsh-base` patch mounts the skill provider and model tool already; LSP needs explicit composition. These statements were checked in the published `0.2.0-rc.2` npm tarballs, including their README and `cordis.patch.yml`, rather than inferred from the repository's moving default branch. [Skill provider package](https://registry.npmjs.org/@deepseek-ai/dsh-skill-filesystem/0.2.0-rc.2), [base bundle package](https://registry.npmjs.org/@deepseek-ai/dsh-base/0.2.0-rc.2)

## Candidates

Versions are the registry versions observed on the research date. Hosted MCP services have no client-pinnable service version; the table says so explicitly.

Shared infrastructure: use the shipped `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`, one instance per server. Its released schema supports stdio, Streamable HTTP, headers, reconnect and call timeouts; stdio child environments scrub ambient credential-like variables. No community MCP bridge is needed for this proposal. External service handshakes still require testing. [Official source](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client), [released package](https://registry.npmjs.org/@deepseek-ai/dsh-mcp-client/0.2.0-rc.2)

| #   | Choice                                  | Exact package / service and source                                                                                                                                                                                                     | Benefit and proposed setup                                                                                                                                                                                                      | Dependencies / authentication                                                                                                                                                   | DSH compatibility evidence                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Recommended; already built in           | `@deepseek-ai/dsh-skill-filesystem@0.2.0-rc.2`, with `dsh-skill` and `dsh-tool-skill` at the same release; [official source](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/skill)                               | Reuse repository and `~/.agents/skills`; retain default roots and live watching. Add `~/.codex/skills` through `customSkillDirs` only if its specific skills are also wanted.                                                   | No new account or service; local skills must have valid frontmatter. Nested plugin-cache layouts are not recursively discovered.                                                | Published release documents default roots, custom directories, duplicate precedence, and on-demand loading. Bundled by default.                                                                                                                                                            |
| 2   | Recommended                             | `@deepseek-ai/dsh-lsp`, `@deepseek-ai/dsh-lsp-stdio`, `@deepseek-ai/dsh-tool-lsp`, all `0.2.0-rc.2`; [official source](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/lsp)                                       | Definition, references, implementations and hover for TS/TSX/JS/JSX and Rust. Configure the official provider with local `typescript-language-server --stdio` and `rust-analyzer`.                                              | `typescript-language-server@6.0.1` plus TypeScript; existing Rust toolchain's `rust-analyzer`, checking its actual version before enabling. No cloud auth.                      | Published release documents the three-part composition and schema. Not mounted by the base patch. **Does not provide diagnostics or rename**; keep normal typecheck/compiler checks.                                                                                                       |
| 3   | Preserve; migration needs separate work | Existing local `@open-aiden/dsh-lark-bridge@0.0.10`                                                                                                                                                                                    | Preserve installed artifact and configuration. Repair against the new settings API before re-enabling Lark integration; do not overwrite with registry latest.                                                                  | Existing Lark credentials; this research did not read them. Original local package source/archive must be located before rebuilding.                                            | Main task's local startup verification found incompatible `deepEqualJson` import from `dsh-settings`, plus removed `settings.register` API. Registry latest reported by the main task is `0.0.8`, older than the installed local version. It is **not compatible as currently installed**. |
| 4   | Recommended                             | `@upstash/context7-mcp@4.1.1`; [Upstash source](https://github.com/upstash/context7), [version metadata](https://registry.npmjs.org/@upstash/context7-mcp/4.1.1)                                                                       | Version-specific library documentation. Prefer the official remote endpoint `https://mcp.context7.com/mcp`, or pinned stdio `npx -y @upstash/context7-mcp@4.1.1`.                                                               | Network; API key recommended for higher rate limits. Local package requires Node `>=20.18.1`.                                                                                   | Standard MCP transport matches official DSH client. Service integration not locally tested. Remote service version is provider-managed.                                                                                                                                                    |
| 5   | Recommended                             | DeepWiki hosted MCP, `https://mcp.deepwiki.com/mcp`; [official documentation](https://docs.devin.ai/work-with-devin/deepwiki-mcp)                                                                                                      | Ask architectural questions about public GitHub repositories; use `ask_question` before broad reading.                                                                                                                          | No authentication for public repository service; network only. Private repositories require a different authenticated Devin product.                                            | Official service documents Streamable HTTP; matches DSH transport. No locally pinned package or service release. Integration not locally tested.                                                                                                                                           |
| 6   | Recommended browser option              | `@playwright/mcp@0.0.83`; [Microsoft source](https://github.com/microsoft/playwright-mcp), [version metadata](https://registry.npmjs.org/@playwright/mcp/0.0.83)                                                                       | Accessibility-based web interaction and UI checks. Proposed stdio command `npx -y @playwright/mcp@0.0.83 --isolated`; default to the local development app.                                                                     | Node `>=18`, compatible browser. No MCP API key; individual sites can require login. Isolated sessions do not preserve login state.                                             | Standard stdio MCP; not a DSH-native plugin. Local handshake and actual page action remain to be tested. Existing `agent-browser` skill is a lighter alternative if sufficient.                                                                                                            |
| 7   | Optional, performance work              | `chrome-devtools-mcp@1.10.1`; [Chrome DevTools source](https://github.com/ChromeDevTools/chrome-devtools-mcp), [version metadata](https://registry.npmjs.org/chrome-devtools-mcp/1.10.1)                                               | Performance traces, network/console diagnosis. Enable for profiling sessions rather than alongside Playwright all day. Proposed flags: `--isolated --no-usage-statistics`.                                                      | Node `^20.19.0                                                                                                                                                                  |                                                                                                                                                                                                                                                                                            | ^22.12.0                                     |                                                                                                                                                                                                                                    | >=23`, Chrome stable. No service credential. | Standard stdio MCP; integration untested. Usage statistics default on upstream; proposed configuration opts out. |
| 8   | Optional, GitHub workflow               | GitHub hosted MCP at `https://api.githubcopilot.com/mcp/readonly`; [official source](https://github.com/github/github-mcp-server), [remote configuration](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) | Read repositories, PRs, issues and Actions through tools. Start with read-only `repos,issues,pull_requests,actions` toolsets; existing `gh` already covers many tasks.                                                          | GitHub PAT supplied via secure credential/environment reference. Do not assume DSH supports GitHub's interactive OAuth integration. Remote service version is provider-managed. | GitHub documents PAT support for generic remote MCP hosts and `/readonly`; DSH's HTTP headers support is published. Integration untested.                                                                                                                                                  |
| 9   | Recommended if terminal-first           | `@deepseek-harness-tui/dsh-tui@0.12.0`; [maintainer source](https://github.com/ccch1mneyyy/dsh-TUI), [version metadata](https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui/0.12.0)                                               | Terminal UI with streaming, sessions, file references and approval surfaces. Install to a separate `tui` profile; preserve the user's existing `web` profile and Lark bridge.                                                   | Node `^22.19                                                                                                                                                                    |                                                                                                                                                                                                                                                                                            | >=24`, pnpm, existing DSH model credentials. | Published peer ranges explicitly include host `0.2.0-rc.2`. This is stronger than generic protocol compatibility, but a real terminal smoke test is still required. The old `dsh-cc-tui@0.4.2` package is not the current package. |
| 10  | Recommended, local only                 | `@goodandready/dsh-plugin-notify@0.3.8`; [maintainer source](https://github.com/GooDAnDReaDY/dsh-plugin-notify), [version metadata](https://registry.npmjs.org/@goodandready/dsh-plugin-notify/0.3.8)                                  | Notify on completed tasks, errors and pending approval. Proposed `local: true`, all webhook channels empty, sound off, `notifyBackgroundOnly: true`, and browser desktop notifications off initially to avoid duplicate alerts. | macOS `osascript` for local notifications; browser notification permission only if browser notifications are later enabled. No messaging credentials for this proposal.         | Published peer ranges cover `^0.2.0-rc.1`. Source describes local macOS behavior. Local delivery and background-only behavior need a real session check.                                                                                                                                   |
| 11  | Optional, usage visibility              | `dsh-cost-meter@1.8.10`; [maintainer source](https://github.com/Han-1413141/dsh-cost-meter), [version metadata](https://registry.npmjs.org/dsh-cost-meter/1.8.10)                                                                      | Session/model usage, estimated costs and history. Begin with usage and local estimation; leave extra provider-balance/coding-plan integrations unconfigured.                                                                    | Node `>=20`, pnpm. Extra balances/quotas need corresponding credentials; estimates are not invoices.                                                                            | Published host peer range includes `>=0.2.0-rc.1 <0.3.0-0`. UI and price correctness not independently tested.                                                                                                                                                                             |
| 12  | Optional, discovery only initially      | `dshmarket@1.66.8`; [maintainer source](https://github.com/dsh-market/dsh-market), [version metadata](https://registry.npmjs.org/dshmarket/1.66.8)                                                                                     | Browse/search available plugins in the web UI. Treat registry cards as discovery pointers, then check the actual publisher/source before installing.                                                                            | Web profile, pnpm; GitHub/network access. No need to add another broad UI bundle merely for discovery.                                                                          | Published settings peer range includes `^0.2.0-rc.1`. No local smoke test. Correct npm package is `dshmarket`, not `dsh-market` (404 during research).                                                                                                                                     |

## Proposed configuration excerpts

These are reviewable templates, not changes applied to `~/.dsh`. The final profile patch must be merged with existing row IDs after user selection. Do not replace the existing profile file.

The following schema was read from the released `dsh-mcp-client@0.2.0-rc.2` tarball. Credentials are intentionally absent. Initial Context7 setup can use its unauthenticated quota, then add a credential reference if requested. [Released MCP package](https://registry.npmjs.org/@deepseek-ai/dsh-mcp-client/0.2.0-rc.2)

```yaml
- insert:
    - id: mcp-context7
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: streamable-http
        serverName: context7
        url: https://mcp.context7.com/mcp
    - id: mcp-deepwiki
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: streamable-http
        serverName: deepwiki
        url: https://mcp.deepwiki.com/mcp
    - id: mcp-playwright
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: stdio
        serverName: playwright
        command: npx
        args: ["-y", "@playwright/mcp@0.0.83", "--isolated"]
```

Official LSP composition, assuming the existing profile already provides the official filesystem and subprocess services. Resolve the actual executable paths before applying: an unavailable configured executable prevents provider registration. This tool performs navigation; it does not replace `pnpm typecheck` or Rust compiler checks. [Released stdio provider](https://registry.npmjs.org/@deepseek-ai/dsh-lsp-stdio/0.2.0-rc.2), [released model tool](https://registry.npmjs.org/@deepseek-ai/dsh-tool-lsp/0.2.0-rc.2)

```yaml
- insert:
    - id: lsp
      name: "@deepseek-ai/dsh-lsp"
    - id: lsp-stdio
      name: "@deepseek-ai/dsh-lsp-stdio"
      config:
        servers:
          typescript:
            command: typescript-language-server
            args: ["--stdio"]
            extensionToLanguage:
              ".ts": typescript
              ".tsx": typescriptreact
              ".js": javascript
              ".jsx": javascriptreact
          rust:
            command: rust-analyzer
            extensionToLanguage:
              ".rs": rust
    - id: tool-lsp
      name: "@deepseek-ai/dsh-tool-lsp"
```

If approved, the TUI's isolated profile install target is:

```sh
rtk dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui@0.12.0
```

## Excluded or deferred alternatives

- **Community `omdsh-dev/dsh-lsp`: exclude.** Its source still declares its package as `@deepseek-ai/dsh-lsp@0.0.1` and requires `dsh-tools <0.2.0`, while the official npm package at that name is now an official LSP abstraction. Using the community GitHub install and the official package name interchangeably is incorrect. [Community package source](https://github.com/omdsh-dev/dsh-lsp/blob/main/package.json), [official registry package](https://registry.npmjs.org/@deepseek-ai/dsh-lsp/0.2.0-rc.2)
- **`dsh-mcp-adapter@0.6.3`: defer.** Its single proxy-tool approach may reduce schema overhead, but adds an alternative discovery/call layer. Start with the official bridge; reconsider only after measured context overhead. This npm package is real and matches the maintainer repository. [Source](https://github.com/NexusAgentX/dsh-mcp-adapter), [registry](https://registry.npmjs.org/dsh-mcp-adapter/0.6.3)
- **`dsh-context7@0.2.0`: defer.** Valid native package from `Nrxous/dsh-context7`, but duplicates the official Context7 MCP capability. Choose one. [Source](https://github.com/Nrxous/dsh-context7), [registry](https://registry.npmjs.org/dsh-context7/0.2.0)
- **`dsh-repo-setup@0.1.7`: defer.** The package is real and describes a read-only repository scan plus recommendations. This repository already has extensive rules and skills, making it less valuable than improving navigation/browser tools. [Source](https://github.com/gongyijie85/dsh-repo-setup), [registry](https://registry.npmjs.org/dsh-repo-setup/0.1.7)
- **Large skill packs, automatic permission policies, and broad UI replacement bundles: defer.** Existing project rules and reusable skills cover the workflow requirement; adding competing instructions and broad interfaces is unnecessary for the initial selected setup. This is a scope recommendation, not a compatibility finding.

## Verification after confirmation

1. Preserve the current `web` profile and the existing local Lark bridge; capture a reversible configuration backup before changes.
2. Pin selected community/server package versions and keep official Harness components on the CLI's `0.2.0-rc.2` release. Several official component `latest` tags still point to `0.0.1-rc.1`; do not blindly add unversioned official components.
3. Inspect merged profile composition and startup logs. Confirm there is one namespace per MCP server and no duplicate service providers.
4. Load one existing project/shared skill; navigate one TSX symbol and one Rust symbol; fetch one library document; ask DeepWiki about a public repository.
5. Drive a local app page in the chosen browser tool. Verify an actual completion/approval notification. If TUI selected, check terminal input, approval and session resume.
6. Report which checks were performed and which require user credentials. Package metadata or a clean startup alone is not proof of a working external service.

## Sources

The table and configuration sections link owning repositories, official docs, and exact npm version metadata. Community indexes were used to discover candidates, not as compatibility proof. Repository pages can move; exact released npm metadata/tarballs were used to distinguish shipped `0.2.0-rc.2` behavior from development-branch documentation. No secrets or local credential files were read for this research.

## Expanded native-plugin research after setup authorization

The user subsequently authorized a fuller setup. This section expands the shortlist with native DSH capabilities; it does not itself install packages or edit the user's profile. Versions and tarball contents were checked again on 2026-10-04. The main task reported only approximately 2.2 GiB free, so package size and dependency count matter. Sizes below are npm `dist.unpackedSize` for the package itself, **not total installed size including dependencies, caches or generated data**.

The strongest additional candidates are `dsh-context`, `dsh-prompt`, `dsh-session-manager`, and the previously deferred `dsh-repo-setup`. The first three provide concrete UI capabilities; the small repository scanner becomes useful across the user's other repositories. `dsh-artifact` is a fifth candidate if its current remote-service API passes a smoke test. Metadata compatibility never substitutes for that test.

| Candidate               | Capability beyond the initial set                                                                                                                                            | Published package / size / dependencies                                                                                                                                                                                                                       | Host evidence and proposed decision                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context composition     | Inspect prompt/tool/message composition, per-request growth, compaction/pruning, file activity and agent relationships. This is the reason to add it alongside a cost meter. | `dsh-context@0.63.0`, 856,224 bytes; `zod`, host/React peers. [Repository](https://github.com/bowenliang123/dsh-context), [exact metadata](https://registry.npmjs.org/dsh-context/0.63.0)                                                                     | Manifest explicitly declares `0.2.0-rc.2` compatible. Maintainer's [compatibility evidence](https://github.com/bowenliang123/dsh-context/blob/main/docs/compatibility.md) records disposable-profile install/uninstall against that host with plugin `0.60.0`; current `0.63.0` still needs local runtime verification. **Install candidate.** |
| Prompt toolbox          | Insert reusable/editable templates into the composer, keeping them visible before sending. Complements skills without replacing project instructions.                        | `dsh-prompt@0.2.10`, 1,434,694 bytes; `zod`, `dsh-log@^0.2.1`, `dsh-storage-domain@^0.2.0-rc.2`. [Repository](https://github.com/FeatherHunter/dsh-prompt), [exact metadata](https://registry.npmjs.org/dsh-prompt/0.2.10)                                    | Manifest declares `dsh.engines.dsh >=0.2.0-rc.2`; host entry uses `storageDomain` and `webServer`. **Install candidate**, with remote presentation left off and no update install triggered.                                                                                                                                                   |
| Session manager         | Search/filter/sort sessions; favorites, review-later, tags, notes and priority. Also exposes explicit archive/delete/move/preset migration actions.                          | `dsh-session-manager@0.6.2`, 444,424 bytes; no direct runtime dependencies, `cordis` peer. [Repository](https://github.com/hkkz9522/dsh-session-manager), [exact metadata](https://registry.npmjs.org/dsh-session-manager/0.6.2)                              | No exact `0.2.0-rc.2` promise in inspected manifest. Uses `sessions`, `agents`, `sessionPersistence`, `agentPresets`; move implementation reaches live-writer internals. **Install candidate only after disposable-profile smoke**, verifying list/search/tags first. No automatic deletion/archival schedule was found.                       |
| Repository setup scan   | Read-only stack/test/docs/git/database hints and setup recommendations for unfamiliar projects.                                                                              | `dsh-repo-setup@0.1.7`, 19,176 bytes; no direct runtime dependencies; host tools/Cordis peers. [Repository](https://github.com/gongyijie85/dsh-repo-setup), [exact metadata](https://registry.npmjs.org/dsh-repo-setup/0.1.7)                                 | Manifest explicitly claims `0.2.0-rc.1`; source uses `defineTool` and `ctx.tools.register`, no old settings API. **Install candidate**, then invoke `repo_setup_scan` with an explicit repository path. Recommendations are data, not authorization to install more packages.                                                                  |
| HTML artifacts          | A local `artifact` tool, bundled authoring skill, sandboxed HTML preview and revision history. Useful for reviewable reports/diagrams/prototypes.                            | `dsh-artifact@0.7.0`, 156,580 bytes; `schemastery` dependency plus host/React peers. [Repository](https://github.com/Jannchie/dsh-artifact), [exact metadata](https://registry.npmjs.org/dsh-artifact/0.7.0)                                                  | Wildcard host peers are weak compatibility evidence. Uses `TypertRemoteService`; local import/boot and browser checks required. **Conditional fifth choice**; configure five retained revisions rather than the default twenty.                                                                                                                |
| Git/file review sidebar | Session-specific file tree/editor, changes/diffs and tasks, plus Markdown/Mermaid preview.                                                                                   | `dsh-better-sidebar@0.24.1`, 15,501,753 bytes; many CodeMirror language packages, Mermaid, RxJS and other dependencies. [Repository](https://github.com/omdsh-dev/DSH-better-sidebar), [exact metadata](https://registry.npmjs.org/dsh-better-sidebar/0.24.1) | Host peers cover `^0.2.0-rc.1`; its patch includes a duplicate-mount guard. **Defer on current disk budget**, because much of file/terminal navigation is already native and its dependency closure is materially larger.                                                                                                                      |
| Editable Mermaid canvas | Bidirectional diagram/canvas editing with `mermaid_load` for flowcharts, sequence/class/ER diagrams.                                                                         | `mermaid2aichat-dsh@0.1.5`, 6,504,391 bytes; React Flow, dagre and YAML; React 18 peers. [Repository](https://github.com/supergameboy/mermaid2aichat-dsh), [exact metadata](https://registry.npmjs.org/mermaid2aichat-dsh/0.1.5)                              | Bundle present but no exact host `0.2.0-rc.2` declaration found. **Defer** until editable diagrams are needed; lightweight HTML artifacts cover reports/illustrations first.                                                                                                                                                                   |

### Exact bundle rows and configuration

Published bundle patches insert the IDs below. Use `dsh plugin --profile web add <exact-package-version>` to mount them once, then merge row overrides into the existing profile. The following are **overrides**, not a second set of `insert` rows:

```yaml
- id: dsh-context
  config:
    defaultPlacement: tab
    defaultGranularity: step
    defaultTrendMode: delta
    defaultDeltaBase: step
    defaultToolSort: size
    defaultFileSort: latest
    insightsEntry: hide
    defaultDurationCurve: show

# These three bundles require no extra loader configuration:
# dsh-prompt         -> name: dsh-prompt; config: {}
# dsh-session-manager -> name: dsh-session-manager; config: {}
# dsh-repo-setup     -> name: dsh-repo-setup; no Config export

# Only if the conditional artifact candidate passes its smoke test:
- id: artifact
  config:
    maxArtifactChars: 400000
    maxVersionsPerArtifact: 5
    promptSection: true
    skill: true
```

`dsh-context` also accepts bounded retention fields `maxRequestSteps`, `maxKeptTurns`, `maxEvents`, `maxNodes`, `maxArchiveNodes`, and `maxFileOps`; retain its defaults initially. `insightsEntry: hide` hides the aggregate dashboard entry to avoid duplicating the cost meter; it is **not a network-disable switch**. The artifact store defaults to `$DSH_HOME/artifacts`; omitting `root` preserves that default. Config keys were read directly from the published tarball entrypoints and bundle patches linked above.

`repo_setup_scan` accepts `{ path?: string }` and has a 15-second tool timeout. Pass the intended working directory explicitly because its fallback is the host process cwd. It returns a Markdown report and does not modify repository files. [Published scanner package](https://registry.npmjs.org/dsh-repo-setup/0.1.7)

### Outbound behavior and destructive defaults inspected

This was a targeted source inspection of published host/client files, not a comprehensive security audit.

- **`dsh-prompt`:** template persistence uses same-origin `/_dsh/dsh-prompt/*` endpoints and the local `dsh_prompt` storage domain. `remoteEnabled` starts `false` in both host initial data and browser defaults; this is a remote-control presentation preference, not evidence of a cloud template-sync service. There is a registry update checker: the browser starts checking after eight seconds, then approximately every four hours with jitter. The code displays available updates and exposes an explicit install action; do not trigger that action during pinned installation. No supported loader Config switch to disable those checks was found. `dsh-log` is a local logging dependency. [Published source artifact](https://registry.npmjs.org/dsh-prompt/0.2.10)
- **`dsh-session-manager`:** API calls stay on the host except its registry update check. No auto-delete or auto-archive scheduler was found. The browser starts with an empty selection; single-row delete first sets confirmation state before the action calls `/delete`. Batch actions and migration are explicit UI actions. There is no published `readOnly` Config flag to disable those capabilities. Do not exercise migration/delete against existing user sessions during smoke verification. [Published source artifact](https://registry.npmjs.org/dsh-session-manager/0.6.2)
- **`dsh-context`:** context inspection is local, but pricing lookup can query `models.dev`; opening the relevant balance UI can query the configured DeepSeek platform using its existing account credential. Update-check UI also names npm registries. The inspected Config has no balance/network-disable flag. Source conditionally probes the old settings registration face, and skips it on new hosts instead of calling the removed method unconditionally. [Published source artifact](https://registry.npmjs.org/dsh-context/0.63.0)
- **`dsh-repo-setup`:** no fetch/network code was found in its single runtime entrypoint. Repository reads are local and recommendations contain external links. [Published source artifact](https://registry.npmjs.org/dsh-repo-setup/0.1.7)

### Official Codex delegation: supported, optional, not just a provider toggle

`@deepseek-ai/dsh-subagent-codex@0.2.0-rc.2` is an official bundle, approximately 76 KiB excluding its runtime closure. It depends on `@openai/codex@0.153.4`, including a compatible platform payload; the provider explicitly has **no fallback to the user's global Codex CLI**. Installing it therefore adds a separate native runtime even when Codex is already installed. Defer it while disk is tight and the user already has a working Codex surface. [Exact bundle metadata](https://registry.npmjs.org/@deepseek-ai/dsh-subagent-codex/0.2.0-rc.2), [official documentation](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-codex), [pinned Codex metadata](https://registry.npmjs.org/@openai/codex/0.153.4)

The published bundle inserts host row `subagent-codex`; it registers a dormant provider and starts no process until used. Its Config accepts `providerName` (default `codex`), optional `model` (omit to retain native settings), `env`, `permissionMode` (default `never`) and `disposeGraceMs` (default `3000`). Keep the normal `never` mode; there is no need to choose the explicit sandbox-bypass mode for this setup.

To expose it, copy a full agent preset and enable its existing `tool-subagent-codex` row, whose defaults are:

```yaml
- id: tool-subagent-codex
  name: "@deepseek-ai/dsh-tool-subagent"
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed
```

Remove the copied row's `disabled: true`; do not insert a duplicate tool or assume installing the provider makes it model-visible. Full presets already supply generic job controls for optional background execution. Each task uses a fresh isolated Codex thread in the parent workspace and returns its final answer or safe failure diagnostic, not its intermediate commentary or workspace diff. These details were checked in the released `0.2.0-rc.2` tarball README.

### Additional exclusions discovered

- `dsh-at-file@0.6.3` still contains an unconditional-looking `settings.register(...)` call in its host entrypoint; do not add it to the new host without verifying/migrating that path. It also overlaps newer native file references. [Registry artifact](https://registry.npmjs.org/dsh-at-file/0.6.3)
- `dsh-generative-ui@0.0.5` on npm still declares host peers on `^0.1.5-rc.1`, despite newer compatibility work appearing in the repository. Its `allowExec` defaults true and executes generated-card shell actions without per-command approval (under the session sandbox). Do not install this old release as though the newer repository changes were already published. [Published metadata](https://registry.npmjs.org/dsh-generative-ui/0.0.5), [repository compatibility notes](https://github.com/CNSeniorious000/dsh-generative-ui/blob/main/CLAUDE.md)
- `dsh-session-browser@0.2.0` would add model-visible cross-session browsing plus a SQLite FTS index by overriding `session-query-sqlite` to `openAt: first-search`. It overlaps existing session search and adds an index under the constrained disk budget; defer. [Maintainer source](https://github.com/DDDPG/dsh-plugins), [published metadata](https://registry.npmjs.org/dsh-session-browser/0.2.0)
- Standalone `dsh-revdiff` and `dsh-plugin-diff-review` returned npm 404 during research; their GitHub repositories exist, but they do not meet this pass's published-package criterion. [Revdiff source](https://github.com/BrambleXu/dsh-revdiff), [diff review source](https://github.com/Civitasv/dsh-plugin-diff-review)
