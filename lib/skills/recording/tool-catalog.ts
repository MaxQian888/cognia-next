/**
 * What tool names actually exist, and what to do with the ones a model invents.
 *
 * A generated skill declares `allowedTools`. If the model proposes a name that
 * is not registered, the skill silently does nothing useful at run time — the
 * agent has no such tool, so the instruction is inert. Worse, an unknown name
 * that *looks* plausible reads to a reviewer like a working capability.
 *
 * So the proposal is intersected with the live catalog and the result is shown
 * to the user for confirmation. Unknown names are reported, never silently kept
 * and never silently dropped.
 *
 * The catalog itself has to be assembled here because the repo has no single
 * source for it: SDK core tools exist only as strings scattered through prompts,
 * the sidecar's built-ins live in `lib/settings/builtin-tools`, and plugin tools
 * come from the live plugin registry.
 */

/**
 * Tools the agent SDK provides itself. Not registered anywhere at runtime — the
 * SDK owns them — so they have to be enumerated.
 *
 * The list was previously 11 names, so `intersectAllowedTools` classified every
 * other SDK tool as `unknown` and `generate-skill` stripped it from the saved
 * skill while telling the user it does not exist — `ReadMcpResource` being the
 * clearest case: the SDK ships it and the Anthropic rail would run it.
 *
 * CAVEAT on how this is maintained. The vendored `sdk-tools.d.ts` exposes only
 * `ToolInputSchemas`, a union of INPUT type names — and those are not tool
 * names (`FileReadInput` backs the `Read` tool). So this list cannot be derived
 * mechanically. The entries below are the subset whose input-type name matches
 * the documented tool name one-for-one; names requiring a guess at the mapping
 * (`FileEdit`/`FileRead`/`FileWrite`, `Mcp`, `REPL`, `Agent`, …) are
 * deliberately omitted rather than invented. Treat this as a floor, not a
 * complete roster, and re-check on SDK upgrade.
 */
export const SDK_CORE_TOOL_NAMES: readonly string[] = [
  // Pre-existing entries (the documented Claude Code core surface).
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
  // Structured session tasks — same spelling as `builtin-tools-data.json`.
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskStop",
  // Plan-mode signal (the Anthropic rail uses the SDK-native one; the ai-sdk
  // rail synthesises its own lowercase `exit_plan_mode`).
  "ExitPlanMode",
  // Elicitation — cognia's host-routed `ask_user` mirrors this.
  "AskUserQuestion",
  // Long-running condition watch — same spelling as the sidecar's own Monitor.
  "Monitor",
  // MCP resource surface. Absent from every cognia rail today; see the
  // implementation chapter of the 2026-08-14 tool audit.
  "ListMcpResources",
  "ReadMcpResource",
  "ReadMcpResourceDir",
  "RefreshMcpTools",
  // Worktree lifecycle. Ships natively; cognia has no equivalent.
  "EnterWorktree",
  "ExitWorktree",
] as const

export interface ToolIntersection {
  /** Proposed names that exist. */
  kept: string[]
  /** Proposed names that do not exist, and were therefore not kept. */
  unknown: string[]
  /** Registered names the model did not ask for. Informational only. */
  available: string[]
}

/**
 * Intersect a model's proposal with what exists.
 *
 * An empty catalog reports **everything as unknown** rather than trusting the
 * proposal: "we could not enumerate tools" is not the same as "these tools are
 * fine", and defaulting to trust here would be the one case where the check does
 * nothing precisely when it is needed.
 */
export function intersectAllowedTools(
  proposed: readonly string[],
  catalog: readonly string[]
): ToolIntersection {
  const known = new Set(catalog)
  const kept: string[] = []
  const unknown: string[] = []
  const seen = new Set<string>()

  for (const raw of proposed) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    if (known.has(name)) kept.push(name)
    else unknown.push(name)
  }
  return { kept, unknown, available: [...catalog] }
}

/**
 * Assemble the live catalog.
 *
 * Dynamic imports so this module stays usable from the node-env tests that cover
 * the pure intersection, without dragging the plugin runtime in.
 */
export async function collectRegisteredToolNames(): Promise<string[]> {
  const names = new Set<string>(SDK_CORE_TOOL_NAMES)

  try {
    const { listBuiltinTools, namespaced } = await import("@/lib/settings/builtin-tools")
    for (const tool of listBuiltinTools()) {
      names.add(namespaced(tool.name))
    }
  } catch {
    // The sidecar tool list is optional context, not a hard dependency — a
    // failure here narrows the catalog rather than breaking generation.
  }

  try {
    const { getPluginManager } = await import("@/lib/plugin/core/manager")
    const registry = getPluginManager()?.getRegistry()
    for (const tool of registry?.getAllTools() ?? []) {
      if (tool?.name) names.add(tool.name)
    }
  } catch {
    // Same: plugins may not be initialized on this surface.
  }

  return [...names].sort()
}
