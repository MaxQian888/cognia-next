# Pi Coding Agent plugin stack: practical recommendations

**Research date:** 2026-08-13  
**Scope:** Pi packages/extensions that add capabilities. This report deliberately does not repeat base model or session settings. Versions and download counts are a dated snapshot, not compatibility promises.

## Executive recommendation

Do not turn Pi into a “maximal” agent by installing every popular package. Pi packages execute with the same OS authority as Pi, and every always-visible tool consumes model attention. For Cognia development, the best default is:

1. one policy layer (`@aliou/pi-guardrails` for worktree-friendly prompts, or `pi-permission-modes` for a normal clone with Bash sandboxing);
2. one footer (`@narumitw/pi-statusline`);
3. structured planning (`@narumitw/pi-plan-mode`);
4. MCP through one lazy adapter only (`pi-mcp-adapter`);
5. bounded, blocking-only subagents (`@narumitw/pi-subagents`);
6. user-driven Git worktree and PR status helpers.

Add web/browser, persistent memory, and autonomous goal continuation only when a real workflow needs them. Never install overlapping implementations of safety, MCP, plan mode, browser automation, or the footer.

The strongest evidence in this ecosystem comes from recent releases, package manifests, documented threat models, and tests—not download rank alone. Pi's package registry itself warns that packages can execute code and influence agent behavior.

## Non-negotiable security boundary

Pi has no built-in package sandbox or permission system. Project trust controls whether project-supplied instructions and resources load; it does **not** restrict what a trusted extension can do. A package, an MCP server, a browser extension, and a subagent process can all read files and use credentials available to the current macOS user. See Pi's [security model](https://pi.dev/docs/latest/security), [package documentation](https://pi.dev/docs/latest/packages), and [containerization guidance](https://pi.dev/docs/latest/containerization).

Consequently:

- Review the exact release source before installation and pin the version.
- Store secrets in environment variables or a local secret manager, never committed package configuration.
- Treat policy extensions as accident prevention. For hostile repositories or untrusted tools, run the **whole Pi process** in Docker, OpenShell, or a VM.
- Project-local package configuration must only tighten policy. Do not let an untrusted repository choose new privileged extensions or MCP servers.
- A worktree is important here: `pi-permission-modes` documents that its OS Bash sandbox cannot handle a real worktree/submodule `.git` file and falls back to confirmation prompts. It fails visibly, but is no longer containment.

## Recommended packages

Download figures are those shown by pi.dev or npm for the roughly 30-day/week window visible on 2026-08-13.

| Tier                         | Package, pinned version                                                                                    | Maintenance signal                                                                                                  | Capability and cost                                                                                                                                                                                                                 | Main risk / overlap                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core                         | [`@aliou/pi-guardrails@0.17.0`](https://pi.dev/packages/%40aliou/pi-guardrails)                            | Published 2026-08-10; 5,278/mo, 1,722/wk; tests/typecheck documented                                                | Deterministic protected-file, outside-workspace, and dangerous-command prompts. Four extension entry points, but no OS sandbox. Run `/guardrails:onboarding`, then `/guardrails:settings`.                                          | Full-authority extension; prompts are not containment. Choose this **or** `pi-permission-modes`, not both.                                                                                                                                     |
| Core alternative             | [`@gotgenes/pi-permission-system@25.0.0`](https://pi.dev/packages/%40gotgenes/pi-permission-system)        | Published 2026-08-11; 27K/mo, 4,115/wk; fail-closed rules, tests, and active maintenance                            | Detailed allow/ask/deny policy across tools, Bash, paths, MCP, skills, external directories, and per-agent overrides. Best when policy precision matters more than onboarding simplicity.                                           | Choose this instead of Guardrails or Permission Modes. It is still not an OS sandbox. Native subagent approval forwarding requires the matching `@gotgenes/pi-subagents`, not unrelated subprocess subagent packages.                          |
| Core alternative             | [`pi-permission-modes@2.2.0`](https://pi.dev/packages/pi-permission-modes)                                 | Published 2026-07-19; 1,025/mo, 82/wk; threat model, changelog, and tests in repo                                   | Allow/ask/deny, Bash AST gating, macOS `sandbox-exec`, network allowlist, and tool/skill gating. Injects one sandbox section each turn and adds network/plan tools: moderate fixed prompt cost.                                     | Only model Bash is OS-sandboxed; file tools are policy-gated. Approved escapes run unsandboxed. Worktrees degrade to prompts. Its Plan mode overlaps `pi-plan-mode`; remove `plan` from `cycleOrder` if using both. Never cycle to YOLO.       |
| Core                         | [`@narumitw/pi-statusline@0.49.6`](https://pi.dev/packages/%40narumitw/pi-statusline)                      | Published 2026-08-10; 11.9K/mo, 3,228/wk; 11 test files in source snapshot                                          | Model, thinking, Git, tools, context, cache, time, and cost in the footer. No LLM tool or prompt injection: negligible model-context cost.                                                                                          | One custom footer only; do not combine with `pi-atelier`, `pi-starship`, or another footer.                                                                                                                                                    |
| Core                         | [`@narumitw/pi-plan-mode@0.49.3`](https://pi.dev/packages/%40narumitw/pi-plan-mode)                        | Published 2026-08-05; 16.9K/mo, 7,149/wk; 15 test files                                                             | Conversational read-only planning, explicit completion/handoff, narrow validated Git/`gh` inspection. Tools and plan text are present only during the workflow: moderate temporary context.                                         | Pi cannot give it sandbox-level enforcement. Do not pair with another active Plan implementation.                                                                                                                                              |
| Core UX                      | [`@juicesharp/rpiv-ask-user-question@2.4.0`](https://pi.dev/packages/%40juicesharp/rpiv-ask-user-question) | Published 2026-08-03; 51.6K/mo, 16.4K/wk; maintained monorepo and documented TUI/RPC degradation                    | One structured clarification tool with 2–4 options, previews, notes, and free-form answers. No extra model call or native dependency.                                                                                               | Adds one schema and can interrupt too eagerly; tune its guidance rather than installing another question UI. Plan Mode already has its own plan-only question tool.                                                                            |
| Core UX                      | [`@juicesharp/rpiv-todo@2.4.0`](https://pi.dev/packages/%40juicesharp/rpiv-todo)                           | Published 2026-08-03; 43.1K/mo, 12.4K/wk; maintained monorepo                                                       | Visible task overlay whose state survives reload and compaction by replaying session tool calls. No disk state or API key.                                                                                                          | Use it for implementation progress, not conversational planning. Do not install another todo/task-state extension unless replacing it.                                                                                                         |
| Core when needed             | [`pi-mcp-adapter@2.23.0`](https://pi.dev/packages/pi-mcp-adapter)                                          | Published 2026-08-11; 354.4K/mo, 151.6K/wk; 101 test files; recent fixes; peer Pi `^0.84.1`                         | One lazy proxy tool, disk metadata cache, reconnect/keepalive, and optional promotion of selected tools. About 200 prompt tokens for proxy mode; about 150–300 tokens per promoted direct tool.                                     | MCP servers execute remote/local tools and may receive repository data. Install exactly one adapter; do not also install `pi-codemcp` or `pi-mcp-tools`. Keep 5–20 direct tools; the adapter warns at 75+.                                     |
| Core for delegation          | [`@narumitw/pi-subagents@1.0.0`](https://pi.dev/packages/%40narumitw/pi-subagents)                         | Published 2026-08-11; 7,698/mo, 1,969/wk; 75 test files; active monorepo release workflow                           | Isolated subprocess agents, consultation, auto-routing, and optional detached lifecycle. All mode exposes eight tools; Blocking-only exposes four. Every task starts another model context, so token and latency cost can dominate. | Working-directory trust is not sandboxing. Default concurrency/depth are too broad. Start Blocking-only and bound parallelism.                                                                                                                 |
| Optional                     | [`@narumitw/pi-worktree@0.50.0`](https://pi.dev/packages/%40narumitw/pi-worktree)                          | Published 2026-08-10; 3,084/mo; 10 test files                                                                       | Interactive `/worktree` session switching. No model tool/background work: essentially zero prompt cost.                                                                                                                             | User-driven Git mutation; conflicts with the Bash sandbox limitation noted above.                                                                                                                                                              |
| Optional                     | [`@narumitw/pi-github-pr@0.49.3`](https://pi.dev/packages/%40narumitw/pi-github-pr)                        | Published 2026-08-05; 3,371/mo; active monorepo                                                                     | Passive current-branch PR status via authenticated `gh`, refreshed periodically and after turns. No model tool or comment-body injection: negligible prompt cost.                                                                   | Repeated process/network calls; account visibility follows `gh` auth. It is status only, not a replacement for explicit `gh` review commands.                                                                                                  |
| Optional                     | [`@narumitw/pi-lsp@0.49.4`](https://pi.dev/packages/%40narumitw/pi-lsp)                                    | Current package; 16.1K/mo; same maintained monorepo                                                                 | Targeted diagnostics and source-fix tools; two additional schemas and short-lived language-server processes.                                                                                                                        | Narrower than a full IDE LSP: no general references/rename workflow. `pnpm typecheck`, Rust checks, and project tests remain authoritative.                                                                                                    |
| Optional local               | [`pi-rtk-optimizer@0.9.0`](https://pi.dev/packages/pi-rtk-optimizer)                                       | Published 2026-07-03; 12.9K/mo, 3,738/wk; maintained source and runtime guard                                       | Rewrites supported shell commands through the installed `rtk` binary and compacts noisy Bash/read/grep output. Particularly relevant on this machine, where RTK is already required.                                                | Compaction can hide evidence or invalidate exact edit anchors. Start in suggestion/rewrite mode with lossy source filtering disabled; turn compaction off for audits and hard debugging.                                                       |
| Optional web                 | [`pi-web-access@0.22.0`](https://pi.dev/packages/pi-web-access)                                            | Published 2026-08-11; 222K/mo, 75.6K/wk; active releases                                                            | Four tools: search, fetch, bounded cached retrieval, and claim checking; supports GitHub/PDF/video. Large 7.1 MB package, 8 dependencies, many providers. Fetched content—not the schemas—is the main context cost.                 | Broad outbound network and provider/credential surface. Keep remote hosted fetchers disabled; cap inline content; avoid cookie-based providers. Do not paste keys into JSON.                                                                   |
| Optional browser             | [`@narumitw/pi-chrome-devtools@0.51.0`](https://pi.dev/packages/%40narumitw/pi-chrome-devtools)            | Published 2026-08-11; 7,418/mo, 2,120/wk; 6 test files                                                              | Lazily exposes native CDP capabilities for navigation, evaluation, screenshots, and target selection. Five capability tools after loading: low until activated, moderate thereafter.                                                | Attaching to a personal Chrome profile exposes logged-in pages and cookies. Prefer its isolated temporary profile. Choose it **or** an MCP/browser extension for the same job. Cognia already has `agent-browser`; do not add this by default. |
| Optional long task           | [`@narumitw/pi-goal@0.51.0`](https://pi.dev/packages/%40narumitw/pi-goal)                                  | Published 2026-08-11; 30.2K/mo, 9,340/wk; 20 test files                                                             | Session-scoped goals and guarded automatic continuation. `after-first-goal` delays its tool surface. Runtime/token cost can be very high because it continues turns.                                                                | Autonomous continuation can compound cost or repeat a bad action. Use explicit token budgets and low continuation limits. Do not combine with `pi-workflow`.                                                                                   |
| Optional memory              | [`pi-memory@0.4.2`](https://github.com/jayzeng/pi-memory)                                                  | npm release 2026-08-11; pi.dev still displayed 0.4.0; recent release but only one test file in the inspected source | Seven memory tools, Markdown storage, stable snapshots, optional `qmd` semantic indexing. Seven schemas plus recalled content are a meaningful context tax; deep search can take ~10 seconds.                                       | Persistent private/stale facts and background indexing. Project ADRs and `AGENTS.md` must remain source of truth. Keep writes explicit and semantic updates manual.                                                                            |
| Delegation alternative       | [`pi-subagents@0.47.1`](https://pi.dev/packages/pi-subagents)                                              | Published 2026-08-12; 214K/mo, 69.6K/wk; 3.1K GitHub stars and active tests/docs                                    | Rich subprocess delegation, workflows, fleet UI, MCP selection, schedules, and background runs. Use compact tool descriptions and cap concurrency/depth.                                                                            | Much broader than the Narumitw package and easier to over-configure. Its child processes do not natively forward `@gotgenes/pi-permission-system` ask prompts; keep child agents read-only or use explicit non-interactive deny policies.      |
| Policy-integrated delegation | [`@gotgenes/pi-subagents@19.2.2`](https://pi.dev/packages/%40gotgenes/pi-subagents)                        | Published 2026-08-10; 8,460/mo, 1,381/wk; maintained fork with typed lifecycle events                               | In-process subagents with native registration and ask-state forwarding to `@gotgenes/pi-permission-system`.                                                                                                                         | Choose it only as part of the Gotgenes policy stack. Do not install it alongside another subagent implementation.                                                                                                                              |
| UI alternative               | [`pi-atelier@0.8.1`](https://pi.dev/packages/pi-atelier)                                                   | Published 2026-08-12; 3,701/mo, 978/wk; no runtime dependencies                                                     | Responsive footer/sidebar, context thresholds, session/compaction controls, and completion notification in one package. No model tools.                                                                                             | Young, broad UI replacement. Use instead of statusline plus notification—not alongside them.                                                                                                                                                   |

The `@narumitw/*` packages above come from the maintained [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) monorepo. Its README explicitly recommends installing only the extensions needed. Do not install the repository root as an unfiltered bundle.

## Packages to defer or avoid

| Package                                                                | Decision                               | Evidence                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@narumitw/pi-workflow@0.2.0`                                          | **Experimental; defer.**               | The source labels it experimental. It combines plan and goal lifecycle at a much earlier version; installing it beside `pi-plan-mode`/`pi-goal` duplicates state machines.                            |
| `pi-permission-system@0.8.0`                                           | **Avoid on Pi 0.84.1.**                | Its npm peer range enumerates Pi versions through 0.80, not 0.84.1. Reconsider after a compatible release.                                                                                            |
| `@vtstech/pi-long-term-memory@1.3.5`                                   | **Not recommended.**                   | Its package page describes automatic injection of roughly 4K tokens on every turn; only 191 monthly downloads in the observed snapshot. Prefer explicit `pi-memory` retrieval.                        |
| `pi-smart-voice-notify@0.6.0`                                          | **Avoid on Pi 0.84.1/macOS.**          | npm peers stop at Pi 0.80 and the package is Windows-oriented.                                                                                                                                        |
| `pi-finish-notification@1.0.4`                                         | **Optional only after source review.** | Tiny footprint and no model context, but just 102/mo and 22/wk and limited source/maintenance evidence on its package metadata. Atelier already supplies notifications.                               |
| `pi-voice-input@0.3.4`                                                 | **Experimental opt-in.**               | macOS microphone input and VolcEngine ASR are useful for Chinese/English dictation, but audio leaves the machine and the API key is stored in a local plaintext config. Prefer macOS Dictation first. |
| Additional MCP adapters, browser controllers, safety gates, or footers | **Avoid duplicates.**                  | They compete for the same hooks/tool names, produce repeated prompts, and enlarge schemas without adding independent capability.                                                                      |

## Three coherent stacks

These are package-only fragments for `~/.pi/agent/settings.json`. Exact npm pins are intentional: Pi's [package docs](https://pi.dev/docs/latest/packages) state that `pi update --extensions` skips exact versioned specs. Review release notes, change one pin, and test before advancing it.

### Starter: visible and guarded

For everyday work when existing shell, skills, and `gh` are enough:

```json
{
  "packages": ["npm:@aliou/pi-guardrails@0.17.0", "npm:@narumitw/pi-statusline@0.49.6"]
}
```

After install:

```text
/guardrails:onboarding
/guardrails:examples
```

Choose protected `.env*`, private-key, credential, database-dump, and local-log patterns; set outside-workspace access to ask; and prompt for recursive deletion, privilege escalation, broad permission changes, disk commands, and custom project hazards. Guardrails stores global settings at `~/.pi/agent/extensions/guardrails.json` and a project overlay at `.pi/extensions/guardrails.json`.

### Balanced: recommended Cognia stack

This adds read-only planning, lazy MCP, bounded delegation, and user-driven Git helpers without adding persistent memory or automatic continuation:

```json
{
  "packages": [
    "npm:@aliou/pi-guardrails@0.17.0",
    "npm:@narumitw/pi-statusline@0.49.6",
    "npm:@narumitw/pi-plan-mode@0.49.3",
    "npm:pi-mcp-adapter@2.23.0",
    "npm:@narumitw/pi-subagents@1.0.0",
    "npm:@narumitw/pi-worktree@0.50.0",
    "npm:@narumitw/pi-github-pr@0.49.3"
  ]
}
```

Recommended statusline, at `~/.pi/agent/pi-statusline.json`:

```json
{
  "palettePreset": "ocean",
  "density": "compact",
  "separator": "dot",
  "segments": ["model", "thinking", "cwd", "branch", "context", "cache", "cost"]
}
```

Recommended planning defaults, at `~/.pi/agent/pi-plan-mode.json`:

```json
{
  "thinkingLevel": "inherit",
  "defaultPlanTools": ["read", "bash", "grep", "find", "ls"],
  "implementationPlanRetention": "clear-on-start",
  "defaultPlanExportPath": "PLAN.md",
  "safeSubcommands": {
    "git": [
      "status",
      "log",
      "diff",
      "show",
      "branch",
      "remote",
      "ls-files",
      "grep",
      "rev-parse",
      "blame",
      "describe",
      "merge-base",
      "ls-tree",
      "cat-file"
    ],
    "gh": ["pr view", "pr list", "issue view", "issue list"]
  }
}
```

The extension validates exact safe subcommands, rejects redirection/chaining, and requires JSON output for safe `gh` inspection. This is reduced mutation, not confidentiality: history and remote metadata can still contain secrets.

Recommended subagent bounds, at `~/.pi/agent/pi-subagents.json` (create it from `/subagents` so the package writes the current schema, then apply these values):

```json
{
  "blocking": {
    "enabled": true,
    "maxParallelTasks": 4
  },
  "stateful": {
    "enabled": false,
    "transport": "auto",
    "completionDelivery": "auto-resume",
    "maxAgents": 6,
    "maxActiveTurns": 2,
    "maxDepth": 1,
    "maxChildrenPerAgent": 2,
    "maxMailboxMessages": 40,
    "maxMailboxMessageBytes": 16384,
    "idleTtlMs": 1800000,
    "retentionDays": 7,
    "maxStoredAgents": 20
  },
  "cwdPolicy": {
    "consultation": "anywhere",
    "delegation": "trusted-targets"
  },
  "consult": {
    "resources": "project-context"
  }
}
```

Use the `/subagents` manager to select **Blocking-only**. The disabled stateful section is intentionally retained for a later controlled trial. Do not raise depth until one-level delegation has shown a concrete limitation.

MCP layout:

```text
~/.config/mcp/mcp.json       shared user server definitions
~/.pi/agent/mcp.json         Pi-specific user overrides
<repo>/.pi/mcp.json          reviewed project definitions only
```

Start in proxy/lazy mode. Promote only a stable 5–20 tool working set, prefer `freezeDirectTools: true` for cache stability, and keep unused servers disabled. The adapter does not auto-load arbitrary host MCP configs by default—keep that behavior. Never commit credentials.

### Power-user: explicit autonomy, still bounded

Use this only after the balanced stack has run cleanly for at least a week. Replace Guardrails with the sandbox mode package only in a normal clone; in a worktree, keep Guardrails or use whole-process isolation.

```json
{
  "packages": [
    "npm:pi-permission-modes@2.2.0",
    "npm:@narumitw/pi-statusline@0.49.6",
    "npm:@narumitw/pi-plan-mode@0.49.3",
    "npm:pi-mcp-adapter@2.23.0",
    "npm:@narumitw/pi-subagents@1.0.0",
    "npm:@narumitw/pi-goal@0.51.0",
    "npm:@narumitw/pi-worktree@0.50.0",
    "npm:@narumitw/pi-github-pr@0.49.3",
    "npm:@narumitw/pi-lsp@0.49.4",
    "npm:pi-web-access@0.22.0"
  ]
}
```

Run `/perm init`, then make the global mode header exactly:

```json
{
  "$schema": "https://raw.githubusercontent.com/wynainfo/pi-permission-modes/main/schemas/permission-mode.schema.json",
  "defaultMode": "default",
  "cycleOrder": ["default", "build"]
}
```

The package layers omitted mode bodies over its stock defaults. If `/perm init` generated explicit `modes`, retain those bodies and change only the header fields above. The standalone plan package owns planning, and YOLO is unreachable from the mode cycle. Add project `.pi/permission-mode.json` as a **tighten-only** overlay for Cognia-specific protected paths. Confirm `/sandbox` reports active containment before treating Build as sandboxed.

Goal settings at `~/.pi/agent/pi-goal.json`:

```json
{
  "toolVisibility": "after-first-goal",
  "experimental": {
    "goals": false
  },
  "rpc": {
    "enabled": false
  },
  "continuationLimits": {
    "automaticTurns": 12,
    "noProgressTurns": 3
  }
}
```

Start goals with an explicit token budget (for example, `/goal --tokens 100k ...`). Do not start a goal while detached subagents are still pending until the completion-delivery behavior has been tested in a disposable repository.

For web access, keep only the four default tools, set `fetchRouting.allowRemoteHostedProviders` to `false`, prefer a self-hosted SearXNG or keyless/default route, and bound returned text through `maxInlineContentChars`. The package stores full fetched content in a private one-hour cache (128 entries / 128 MiB); retrieval tools should page or find passages instead of injecting an entire page. Use environment variables for provider keys.

## Browser, memory, notifications, and voice: choose, do not accumulate

### Browser/web

Cognia already has `agent-browser 0.32.4` installed as a shared Agent Skill. Keep it as the default browser automation path. `pi-web-access` is complementary for research/fetching; `pi-chrome-devtools` is an alternative only when native CDP tools materially improve UI debugging. If using it, start with an isolated profile:

```json
{
  "browser": {
    "endpoint": "http://127.0.0.1:9222",
    "autoLaunch": true
  }
}
```

Store that at `~/.pi/agent/pi-chrome-devtools.json`. Do not attach to a daily logged-in profile by default.

### Memory

Do not install memory in the starter or balanced stack. If repeated cross-session recall justifies it, install the exact npm release and keep behavior conservative:

```text
PI_MEMORY_SNAPSHOT=stable
PI_MEMORY_QMD_UPDATE=manual
```

Use explicit `memory_write`; review and delete stale/private entries; never auto-promote memory over repository docs. Pin `pi-memory@0.4.2` even though the registry page lagged at 0.4.0 on the research date.

### UI and notifications

Choose one:

- statusline for a compact, mature footer; or
- Atelier for a sidebar/footer plus completion notification.

Suggested Atelier settings at `~/.pi/agent/pi-atelier.json`:

```json
{
  "preset": "editorial",
  "shortcut": "alt+a",
  "density": "comfortable",
  "contextWarning": 70,
  "contextDanger": 90,
  "showSidebarOnStartup": true,
  "showSidebarToolNames": false,
  "completionNotifications": true
}
```

### Voice

Voice input is not part of a coding baseline. macOS Dictation has a smaller credential and dependency surface. If `pi-voice-input` is trialed, obtain explicit consent for cloud ASR, inspect its microphone and temporary-file behavior, lock down the plaintext credential file, and do not use it for conversations containing repository secrets.

## Context and runtime budget

The useful budget is not “number of packages”; it is always-visible schemas, injected text, spawned model contexts, and external processes:

| Surface                   | Budget rule                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| MCP                       | One proxy tool initially (~200 tokens). Promote 5–20 direct tools (~150–300 each), never entire servers.                     |
| Subagents                 | Blocking-only (four tools) initially. Every task is a fresh paid model context; cap parallel tasks at four and depth at one. |
| Plan                      | Temporary workflow tools only. Clear the retained plan on implementation start to avoid repeated injection.                  |
| Goal                      | Hide until first goal; cap automatic turns at 12 and always give a token budget.                                             |
| Web                       | Four tools; search snippets first, then bounded retrieval. Page content is more expensive than schemas.                      |
| Browser                   | Load one capability set on demand; no duplicate browser implementation.                                                      |
| Memory                    | Seven tools plus retrieved content; install only when recall value exceeds the context and privacy cost.                     |
| Footer/worktree/PR status | Prefer packages with no LLM tools. Their runtime/process cost is small and visible.                                          |

## Team sharing and maintenance

1. Trial globally first, then use project-local `pi install -l npm:<package>@<version>` only after source review.
2. Commit exact package specs in `.pi/settings.json` and non-secret, tighten-only project configuration. Do not commit user credentials, personal MCP servers, memory stores, browser profiles, or fetched-content caches.
3. Record why each package exists, its owner, last review date, and removal criterion next to the project configuration.
4. Monthly: read upstream changelog/releases/issues; compare peer dependencies with the installed Pi version; upgrade one package at a time; run a disposable-repo smoke test; then use the real Cognia lint/typecheck/test workflow.
5. Quarterly: remove packages whose tools have not been used, audit visible tool count, inspect MCP server permissions, prune saved approvals/memory, and re-test destructive-command and outside-workspace denials.
6. Do not run `pi update --extensions` expecting pinned packages to move. Update the exact pin deliberately after review.

## Staged rollout

- **Days 1–3:** Starter stack. Verify protected-file prompts, outside-workspace prompts, dangerous Bash detection, and footer context/cost display.
- **Days 4–7:** Add plan mode. Confirm implementation handoff clears the plan once and that safe Git/`gh` inspection fails closed on mutation/redirection.
- **Week 2:** Add MCP adapter with one server in proxy mode. Promote at most five tools; inspect tool metadata and server logs.
- **Week 3:** Add subagents in Blocking-only mode. Measure provider token use and wall time on three representative tasks before enabling any detached state.
- **Week 4+:** Add Git helpers. Trial exactly one of web access, browser CDP, goal continuation, or memory at a time. Keep only capabilities that demonstrably shorten a recurring workflow.

## Primary sources

- Pi: [Packages](https://pi.dev/docs/latest/packages), [Security](https://pi.dev/docs/latest/security), [Containerization](https://pi.dev/docs/latest/containerization), and the individual pi.dev package pages linked above.
- MCP adapter: [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).
- Maintained extension suite: [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions).
- Guardrails: [aliou/pi-guardrails](https://github.com/aliou/pi-guardrails).
- Permission modes: [wynainfo/pi-permission-modes](https://github.com/wynainfo/pi-permission-modes) and its [threat model](https://github.com/wynainfo/pi-permission-modes/blob/main/SECURITY.md).
- Web access: [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access).
- Memory: [jayzeng/pi-memory](https://github.com/jayzeng/pi-memory).
