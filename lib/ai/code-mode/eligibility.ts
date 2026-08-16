/**
 * Which tools the Code presentation's typed SDK may expose (ADR-0117, Phase 4).
 *
 * The eligibility source is a **first-party allowlist**: a tool appears here
 * only if `lib/settings/builtin-tools-data.json` declares
 * `programmaticReadOnly: true` for it. Two derivations were deliberately
 * rejected:
 *
 *  - **`requiresApproval === false`** means "no per-call prompt", not "no side
 *    effect". `TodoWrite`, `TaskCreate`, `TaskUpdate` and `monitor_cancel` all
 *    carry that flag and all mutate state. `divergesFromApprovalFlag()` exists
 *    so a test can pin that gap rather than letting a future refactor collapse
 *    the two concepts.
 *  - **The MCP `readOnlyHint` annotation**, which a third-party server declares
 *    about its own tools. It is advisory metadata from an untrusted party and
 *    is not a security boundary; a server that lies about it would otherwise
 *    hand generated code a write primitive.
 *
 * Plugin- and MCP-contributed tools are therefore never eligible in the first
 * release. Only tools this repository ships and has classified by hand.
 */

import { BUILTIN_TOOL_CATEGORIES, namespaced } from "@/lib/settings/builtin-tools"
import type { BuiltinToolMeta } from "@/lib/settings/builtin-tools"

export interface ProgrammaticTool {
  /** Bare name, which is also the SDK function name. */
  name: string
  /** SDK-namespaced name used when the call re-enters the tool registry. */
  namespacedName: string
  /** i18n key for the tool's description, reused for the generated doc comment. */
  descriptionKey: string
  category: string
}

/** Every tool explicitly flagged eligible, in metadata order. */
export function programmaticReadOnlyTools(): ProgrammaticTool[] {
  return BUILTIN_TOOL_CATEGORIES.flatMap((category) =>
    category.tools.filter(isFlaggedProgrammatic).map((tool) => ({
      name: tool.name,
      namespacedName: namespaced(tool.name),
      descriptionKey: tool.descriptionKey,
      category: category.id,
    }))
  )
}

export function programmaticReadOnlyToolNames(): string[] {
  return programmaticReadOnlyTools().map((tool) => tool.name)
}

/** Whether a bare tool name may be reached from generated code. */
export function isProgrammaticReadOnly(name: string): boolean {
  return programmaticReadOnlyToolNames().includes(name)
}

function isFlaggedProgrammatic(tool: BuiltinToolMeta): boolean {
  // Strict `=== true`: a tool whose flag is absent, null, or a truthy string
  // is not eligible. Eligibility must be an explicit declaration, never a
  // coercion accident.
  return tool.programmaticReadOnly === true
}

/**
 * Tools that skip the approval prompt but are still NOT eligible.
 *
 * Exported so the divergence is a documented, tested property rather than an
 * accident of ordering — if this ever returns an empty list, someone has
 * quietly redefined eligibility as "does not require approval", which is the
 * exact mistake this module was written to prevent.
 */
export function divergesFromApprovalFlag(): string[] {
  return BUILTIN_TOOL_CATEGORIES.flatMap((category) => category.tools)
    .filter((tool) => tool.requiresApproval === false && !isFlaggedProgrammatic(tool))
    .map((tool) => tool.name)
}

/**
 * Validate a tool name arriving from generated code.
 *
 * The sandbox bridge calls this on every request. It is the choke point that
 * makes the allowlist real: the sandbox has no other route to the tool
 * registry, so a name that fails here cannot be executed at all.
 */
export type EligibilityDecision =
  | { allowed: true; namespacedName: string }
  | { allowed: false; reason: "unknown-tool" | "not-programmatic-read-only" }

export function checkToolEligibility(name: string): EligibilityDecision {
  const trimmed = name.trim()
  const eligible = programmaticReadOnlyTools().find((tool) => tool.name === trimmed)
  if (eligible) return { allowed: true, namespacedName: eligible.namespacedName }

  const known = BUILTIN_TOOL_CATEGORIES.flatMap((category) => category.tools).some(
    (tool) => tool.name === trimmed
  )
  return { allowed: false, reason: known ? "not-programmatic-read-only" : "unknown-tool" }
}
