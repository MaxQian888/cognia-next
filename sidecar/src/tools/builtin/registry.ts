// The built-in tool registry: which definitions a session gets, in which
// order. Category-tool associations come from src/policy/tool-catalog, which
// reads the metadata JSON the React settings UI shares; each rail's adapter
// turns the collected definitions into its own tool format.
//
// Registration order is part of the provider prompt-cache prefix, so the
// categories below are walked in a fixed order and never reordered.

import { fileExtrasTools } from "./file-extras/index.ts"
import { gitTools } from "./git/index.ts"
import { createProcessTools } from "./process/index.ts"
import { environmentTools } from "./environment/index.ts"
import { createShellAdvancedTools } from "./shell-advanced/index.ts"
import { createTerminalReplTools } from "./terminal-repl/index.ts"
import { createAstGrepTools } from "./ast-grep/index.ts"
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
import { defineCategory, type ToolDefinition } from "../kernel/define.ts"
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

const category = defineCategory<CollectToolDefsOptions>

function wantsCoreFiles({ enabled, readTracker, dispatchPath }: CollectToolDefsOptions) {
  return Boolean(
    enabled?.coreFiles &&
    readTracker &&
    (dispatchPath !== "anthropic" || enabled.coreFilesOnAnthropic === true)
  )
}

// Keep every registration position, including the process controls after the
// resolver-bound categories. Order is part of the provider prompt-cache prefix.
const CATEGORIES = [
  category({
    id: "fileExtras",
    isEnabled: ({ enabled }) => Boolean(enabled?.fileExtras),
    tools: fileExtrasTools,
  }),
  category({
    id: "git",
    isEnabled: ({ enabled }) => Boolean(enabled?.git),
    tools: gitTools,
  }),
  category({
    id: "process",
    isEnabled: ({ enabled }) => Boolean(enabled?.process),
    tools: ({ bgShells, builtinProcessSandbox, cwd }) =>
      createProcessTools({ bgShells: bgShells ?? undefined, builtinProcessSandbox, cwd }),
  }),
  category({
    id: "environment",
    isEnabled: ({ enabled }) => Boolean(enabled?.environment),
    tools: environmentTools,
  }),
  category({
    id: "shellAdvanced",
    isEnabled: ({ enabled }) => Boolean(enabled?.shellAdvanced),
    tools: ({ builtinProcessSandbox }) => createShellAdvancedTools({ builtinProcessSandbox }),
  }),
  category({
    id: "terminalRepl",
    isEnabled: ({ enabled }) => Boolean(enabled?.terminalRepl),
    tools: ({ builtinProcessSandbox, sessionId }) =>
      createTerminalReplTools({ builtinProcessSandbox, sessionId }),
  }),
  category({
    id: "astGrep",
    isEnabled: ({ enabled }) => Boolean(enabled?.astGrep),
    tools: ({ cwd }) => createAstGrepTools({ cwd }),
  }),
  category({
    id: "dependencyResearch",
    isEnabled: ({ enabled }) => Boolean(enabled?.dependencyResearch),
    tools: clonedepsTools,
  }),
  category({
    id: "webclone",
    isEnabled: ({ enabled }) => Boolean(enabled?.webclone),
    tools: webcloneTools,
  }),
  category({
    id: "lsp",
    isEnabled: ({ enabled }) => Boolean(enabled?.lsp),
    tools: ({ lspResolver }) => (lspResolver ? createLspTools(lspResolver) : []),
  }),
  category({
    id: "codeGraph",
    isEnabled: ({ enabled }) => Boolean(enabled?.codeGraph),
    tools: ({ codeGraphResolver }) =>
      codeGraphResolver ? createCodeGraphTools(codeGraphResolver) : [],
  }),
  category({
    id: "processControls",
    isEnabled: (context) => Boolean(context.enabled?.process && !wantsCoreFiles(context)),
    tools: ({ bgShells }) =>
      bgShells
        ? [
            createBashOutputTool({ bgShells }),
            createKillShellTool({ bgShells }),
            createListShellsTool({ bgShells }),
          ]
        : [],
  }),
  category({
    id: "coreFiles",
    isEnabled: ({ enabled }) => Boolean(enabled?.coreFiles),
    tools: (context) => {
      const { readTracker, bgShells } = context
      // The Anthropic rail supplies native file tools. If those tools are used,
      // or tracking is unavailable, keep the host-backed Monitor equivalent.
      if (!wantsCoreFiles(context) || !readTracker)
        return createMonitorTools({ hostRpc: context.hostRpc, sessionId: context.sessionId })
      return createCoreTools({ ...context, readTracker, bgShells: bgShells ?? undefined })
    },
  }),
  category({
    id: "exitPlan",
    // Anthropic already provides ExitPlanMode. Keep this absent for unspecified
    // dispatch paths, preserving the bare "no categories → no tools" invariant.
    isEnabled: ({ dispatchPath }) => dispatchPath === "ai-sdk",
    tools: () => [createExitPlanTool()],
  }),
  category({
    id: "planAuthoring",
    // Neither provider supplies create_plan/update_plan; dispatch opts in.
    isEnabled: ({ planTools }) => Boolean(planTools),
    tools: () => createPlanTools(),
  }),
]

/** Collect the session surface in pinned order, then apply shared middleware. */
export function collectCogniaToolDefs(context: CollectToolDefsOptions = {}): ToolDefinition[] {
  const { enabled, builtinProcessSandbox, cwd, toolPresentation } = context
  if (!enabled || typeof enabled !== "object") return []
  const tools: ToolDefinition[] = []
  for (const category of CATEGORIES) {
    if (category.isEnabled(context)) tools.push(...category.create(context))
  }

  // Presentation runs over the confined surface so generated code cannot reach
  // disabled tools or bypass the same confinement as native tool calls.
  const confined = wrapDefsWithConfinement(tools, builtinProcessSandbox, cwd)
  return [...applyToolPresentation(confined, toolPresentation)]
}
