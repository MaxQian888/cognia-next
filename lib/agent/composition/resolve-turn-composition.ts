/**
 * Resolve the composition for one outgoing turn (ADR-0117).
 *
 * This is the single place that turns "what the session selected" into "what
 * this turn actually runs as", and it is what `lib/claude/build-options.ts`
 * projects onto `SendOptions.execution.composition` for the sidecar to read.
 *
 * It exists as its own module rather than inline in the send path for one
 * reason: the send path is `async` and enormous, and a composition decision
 * buried in it would be untestable without standing up a whole send. Every
 * input here is explicit, so the resolution can be exercised directly.
 */

import { compositionForSession } from "@/stores/agent/agent-runtime-store"
import { appPresetCatalog } from "./app-preset-catalog"
import { resolveComposition } from "./resolve-composition"
import { digestPrompt, digestToolSurface, withCompositionDigest } from "./digest"
import type { ToolSurfaceEntry } from "./digest"
import { hostToolPresentations } from "@/lib/ai/code-mode/host-probe"
// `AgentPermissionMode` is owned by the package root; `agent-composition`
// imports it as a dependency and does not re-export it.
import type { AgentPermissionMode } from "@cognia/agent-config-types"
import type {
  AgentCompositionSelectionV1,
  AgentPresetDefinitionV1,
  ResolvedAgentCompositionV1,
} from "@cognia/agent-config-types/agent-composition"

export interface ResolveTurnCompositionInput {
  /** Absent for a turn with no session (e.g. a one-shot completion). */
  sessionId?: string
  /** The final system prompt, already assembled. */
  systemPrompt?: string
  /** The ordered tool surface this turn will offer. */
  tools?: readonly ToolSurfaceEntry[]
  /** Parent agent's resolved authority when this turn is a child. */
  ceiling?: AgentPermissionMode
  /** `resolveAgentExecutionSpec()`'s fingerprint, so the two identities pair up. */
  executionFingerprint?: string
  /** Overrides for tests; production reads the catalog and the host probe. */
  presets?: readonly AgentPresetDefinitionV1[]
  selection?: AgentCompositionSelectionV1
  supportedToolPresentations?: ReturnType<typeof hostToolPresentations>
}

/**
 * Resolve, then stamp the digest.
 *
 * The tool digest covers the surface *as the model will see it*, which is why
 * the caller passes `visibility` per entry rather than this module inferring it
 * from the resolved presentation: in `both` presentation some tools are native
 * and one is the code entry point, and collapsing that would make two genuinely
 * different surfaces share a digest.
 */
export async function resolveTurnComposition(
  input: ResolveTurnCompositionInput = {}
): Promise<ResolvedAgentCompositionV1> {
  // The FULL app catalog, not just built-ins: a session whose selection names a
  // custom or plugin mode has to resolve to that preset here, or the turn runs
  // as Standard while the picker still shows the custom mode.
  const presets = input.presets ?? appPresetCatalog()
  const selection = input.selection ?? compositionForSession(input.sessionId)

  const [promptDigest, toolDigest] = await Promise.all([
    digestPrompt(input.systemPrompt ?? ""),
    digestToolSurface(input.tools ?? []),
  ])

  const resolved = resolveComposition({
    selection,
    presets,
    ceiling: input.ceiling,
    // The host decides whether `code` is even on the table. Passing the probe
    // result here is what makes the fail-closed rule reach the wire: an
    // unsandboxed host resolves a `code` selection down to `native` with a
    // warning, and the sidecar is then told `native`.
    supportedToolPresentations: input.supportedToolPresentations ?? hostToolPresentations(),
    promptDigest,
    toolDigest,
    ...(input.executionFingerprint ? { executionFingerprint: input.executionFingerprint } : {}),
  })

  return withCompositionDigest(resolved)
}

/**
 * Build the tool-surface entries for a turn from a plain list of tool names.
 *
 * A convenience for call sites that do not have schemas to hand. It records
 * `schema: null` rather than omitting the field, so a surface digested without
 * schemas can never collide with the same tools digested with them.
 */
export function toolSurfaceFromNames(
  names: readonly string[],
  visibility: ToolSurfaceEntry["visibility"] = "native"
): ToolSurfaceEntry[] {
  return names.map((name) => ({ name, schema: null, visibility }))
}
