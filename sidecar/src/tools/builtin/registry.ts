// The built-in tool registry: which definitions a session gets, in which
// order. Category-tool associations come from src/policy/tool-catalog, which
// reads the metadata JSON the React settings UI shares; each rail's adapter
// turns the collected definitions into its own tool format.
//
// Registration order is part of the provider prompt-cache prefix, so the
// categories below are walked in a fixed order and never reordered.

import { fileExtrasTools } from "./file-extras/index.ts"
import { gitTools } from "./git/index.ts"
import { processTools, createProcessTools } from "./process/index.ts"
import { environmentTools } from "./environment/index.ts"
import { shellAdvancedTools, createShellAdvancedTools } from "./shell-advanced/index.ts"
import { terminalReplTools, createTerminalReplTools } from "./terminal-repl/index.ts"
import { astGrepTools, createAstGrepTools } from "./ast-grep/index.ts"
import { clonedepsTools } from "./dependency-research/index.ts"
import { webcloneTools } from "./webclone/index.ts"
import { createLspTools } from "./lsp/index.ts"
import { createCodeGraphTools } from "./code-graph/tools.ts"
import {
  createBashOutputTool,
  createKillShellTool,
  createListShellsTool,
} from "./core-files/bash.ts"
import { createCoreTools } from "./core-files/index.ts"
import { createMonitorTools } from "./core-files/monitor.ts"
import { createExitPlanTool } from "./plan/exit-plan.ts"
import { createPlanTools } from "./plan/plan-tools.ts"
import { wrapDefsWithConfinement } from "../middleware/confinement.ts"
import { applyToolPresentation } from "../middleware/presentation.ts"
import type { ToolDefinition } from "../kernel/define.ts"
import type { ReadTracker } from "../state/read-tracker.ts"
import type { SessionTaskStore } from "../state/tasks.ts"
import type { HostRpcCaller, SessionBgShellRegistry } from "../state/host-background-shells.ts"
import type { ProcessSandboxScope } from "../../platform/process/exec.ts"
import type { LazyLspResolver } from "../../services/lsp/lazy-resolver.ts"
import type { CodeGraphIndex } from "../../services/code-graph/index-service.ts"

/** What `collectCogniaToolDefs` assembles a session's built-in surface from. */
export interface CollectToolDefsOptions {
  /** Category toggles by id (`git`, `coreFiles`, …). */
  enabled?: Readonly<Record<string, boolean | undefined>> | null | undefined
  lspResolver?: LazyLspResolver | null | undefined
  codeGraphResolver?: CodeGraphIndex | null | undefined
  readTracker?: ReadTracker | null | undefined
  taskStore?: SessionTaskStore | undefined
  cwd?: string | undefined
  dispatchPath?: "anthropic" | "ai-sdk" | undefined
  bgShells?: SessionBgShellRegistry | null | undefined
  builtinProcessSandbox?: ProcessSandboxScope | undefined
  hostRpc?: HostRpcCaller | null | undefined
  sessionId?: string | undefined
  model?: string | undefined
  provider?: string | undefined
  /**
   * `execution.composition.toolPresentation` from the send spec (ADR-0117).
   * Absent ⇒ `native`, the pre-composition behaviour.
   */
  toolPresentation?: string | undefined
  /**
   * Register the ADR-0045 plan-authoring tools (`create_plan` / `update_plan`).
   * Off unless the caller asks — the dispatch layer opts in per send.
   */
  planTools?: boolean | undefined
}

const TOOLS_BY_CATEGORY: Readonly<Record<string, readonly ToolDefinition[]>> = {
  fileExtras: fileExtrasTools,
  git: gitTools,
  /**
   * Supervisor-bound at collect time: `start_process` / `terminate_process`
   * route through the session's background-job supervisor when one exists, so
   * a `detached` start becomes a reapable, output-capturing job instead of an
   * orphan daemon. Listed here (rather than pushed after the loop) to hold its
   * REGISTRATION POSITION — tool order is part of the cached prompt prefix.
   * The static array is the no-supervisor fallback.
   */
  process: processTools,
  environment: environmentTools,
  shellAdvanced: shellAdvancedTools,
  /**
   * Wave 1 — node-pty-backed interactive REPL surface. Orthogonal to
   * the renderer-relayed `terminal_dock_*` tools (those live in the
   * pluginTools manifest, see `lib/plugin/bridge/sidecar-tools-bridge.ts`):
   * REPL gives the agent a *private* persistent shell in the sidecar
   * for use cases that need stateful I/O (python / claude-code / sql).
   *
   * Lazy node-pty require — when the native binding is missing the
   * tool returns a clean structured error rather than crashing.
   */
  terminalRepl: terminalReplTools,
  /**
   * AST-aware structural code search/replace (`ast_grep_*`), backed by the
   * `ast-grep` CLI. Static like the other categories here — no per-session
   * resolver — but the binary is probed lazily (env / @ast-grep/cli / PATH);
   * when unresolved the tools return a clean structured error.
   */
  astGrep: astGrepTools,
  /**
   * Dependency-source research (`clone_dep_source` / `list_cloned_deps`): clone
   * a dependency's source repo into an ignored `.cognia/clonedeps/` workspace so
   * the agent can read library internals. Static category; uses git + fs.
   */
  dependencyResearch: clonedepsTools,
  /**
   * Web page snapshot + reverse-engineering (`web_clone` / `web_clone_convert`):
   * download a live page's HTML + all CSS/JS/image/font assets into a
   * self-contained single file or directory bundle, with optional component
   * extraction + Vue/React/Angular/Svelte/jQuery codegen. The heavy Node-only
   * engine (linkedom / @babel / node:http / node:fs) is vendored under
   * `sidecar/webclone` and runs as an isolated child process. Static category;
   * uses network + fs (approval-gated).
   */
  webclone: webcloneTools,
}

/**
 * Collect the raw tool definitions for the enabled categories (+ the
 * resolver-bound LSP and code-graph tools). The Claude Agent SDK rail wraps
 * them into an in-process MCP server (`adapters/sdk-mcp.ts`); the AI SDK rail
 * (`adapters/ai-sdk.ts`) converts them into native AI SDK `tool()`
 * objects (ADR-0043). Each def is `{ name, description, inputSchema: <zod raw
 * shape>, handler }`.
 */
export function collectCogniaToolDefs({
  enabled,
  lspResolver,
  codeGraphResolver,
  readTracker,
  taskStore,
  cwd,
  dispatchPath,
  bgShells,
  builtinProcessSandbox,
  hostRpc,
  sessionId,
  model,
  provider,
  toolPresentation,
  planTools = false,
}: CollectToolDefsOptions = {}): ToolDefinition[] {
  if (!enabled || typeof enabled !== "object") return []
  const tools: ToolDefinition[] = []
  for (const [category, toolList] of Object.entries(TOOLS_BY_CATEGORY)) {
    if (!enabled[category]) continue
    // `process` and `astGrep` are the static categories with session-bound
    // variants; swap them in HERE so each keeps its registration position
    // (see the map entries). `astGrep` needs the session cwd — without it the
    // ast-grep child inherited the sidecar's cwd and rewrote the wrong tree.
    if (category === "process")
      tools.push(
        ...createProcessTools({ bgShells: bgShells ?? undefined, builtinProcessSandbox, cwd })
      )
    else if (category === "terminalRepl")
      tools.push(...createTerminalReplTools({ builtinProcessSandbox, sessionId }))
    else if (category === "shellAdvanced")
      tools.push(...createShellAdvancedTools({ builtinProcessSandbox }))
    else if (category === "astGrep") tools.push(...createAstGrepTools({ cwd }))
    else tools.push(...toolList)
  }
  // The `lsp` category is resolver-bound (per-session), so it is not part of
  // the static TOOLS_BY_CATEGORY map — build its tools on demand when the
  // dispatch layer supplies a session LSP resolver.
  if (enabled.lsp && lspResolver) {
    tools.push(...createLspTools(lspResolver))
  }
  // The `codeGraph` category is likewise resolver-bound: its tools wrap a
  // per-session tree-sitter index service supplied by the dispatch layer.
  if (enabled.codeGraph && codeGraphResolver) {
    tools.push(...createCodeGraphTools(codeGraphResolver))
  }
  // The `coreFiles` suite (grep/glob/read/ls/edit/multi_edit/write/bash/
  // TodoWrite) is session-bound like lsp. It exists primarily for the ai-sdk
  // path, where the model has no SDK-native file tools; on the Anthropic path
  // it is OFF by default (the claude-agent-sdk ships its own Grep/Read/Edit/
  // Bash) unless the `coreFilesOnAnthropic` escape hatch is set — e.g. when a
  // user disables the SDK-native tools but still wants file access.
  const coreWanted =
    enabled.coreFiles &&
    readTracker &&
    (dispatchPath !== "anthropic" || enabled.coreFilesOnAnthropic === true)
  if (enabled.process && bgShells && !coreWanted) {
    tools.push(
      createBashOutputTool({ bgShells }),
      createKillShellTool({ bgShells }),
      createListShellsTool({ bgShells })
    )
  }
  if (coreWanted) {
    tools.push(
      ...createCoreTools({
        cwd,
        readTracker,
        lspResolver,
        bgShells: bgShells ?? undefined,
        builtinProcessSandbox,
        taskStore,
        hostRpc,
        sessionId,
        model,
        provider,
      })
    )
  } else if (enabled.coreFiles) {
    // Anthropic supplies native file/shell tools, and an AI-SDK session can
    // withhold the file suite when no read tracker is available. Neither path
    // has a native Monitor equivalent, so keep the three supervisor-backed
    // monitor tools available under the same category toggle.
    tools.push(...createMonitorTools({ hostRpc, sessionId }))
  }
  // The cross-provider plan-ready signal tool. The Anthropic path uses the
  // SDK-native `ExitPlanMode`, so register ours ONLY on the explicit ai-sdk
  // path (never for an unspecified/Anthropic path) to avoid duplicating it and
  // to preserve the "no categories → no tools" invariant. Always present on the
  // ai-sdk path (Claude Code parity — the system prompt governs *when* the
  // model calls it).
  if (dispatchPath === "ai-sdk") {
    tools.push(createExitPlanTool())
  }
  // create_plan / update_plan (ADR-0045 §3.2). Not native on ANY provider, so
  // both dispatch paths register them — but only when the caller asks, so the
  // "no categories → no tools" invariant of a bare `collectCogniaToolDefs`
  // call still holds. The dispatch layer opts in by default; a user can turn
  // it off with `planSettings.agentAuthoring: false`, which rides the send
  // spec as `sendOptions.planTools`.
  if (planTools) {
    tools.push(...createPlanTools())
  }

  // Code tool presentation (ADR-0117 Phase 4). Applied LAST, over the fully
  // assembled native surface, because the code broker dispatches back into
  // exactly these defs — a tool the user disabled is not in `tools`, so it is
  // not reachable from generated code either.
  const confined = wrapDefsWithConfinement(tools, builtinProcessSandbox, cwd)
  return [...applyToolPresentation(confined, toolPresentation)]
}
