/**
 * What will actually run the next turn, as one value.
 *
 * Before this module the answer lived in three persisted fields that could
 * disagree (`runtime`, `externalAgentId`, `externalHostConfig` on
 * `agent-runtime-store`), and the composer chip carried ~40 lines of repair
 * effects whose only job was to reconcile them. A single ref removes the
 * disagreement by construction: there is one field, and it names one lane.
 *
 * The three lanes are genuinely different in kind, which is why this is a union
 * and not an id plus a flag:
 *
 *   - `builtin`  runs inside the bundled Node sidecar. Which sidecar runtime
 *                serves it (`claude-agent-sdk` for Anthropic, `ai-sdk` for
 *                every other provider) is DERIVED from the provider, so the
 *                lane is one choice even though two runtimes implement it.
 *   - `external` runs a locally configured agent process (Codex, Claude Code,
 *                Gemini CLI, a plugin-contributed protocol) on this machine.
 *   - `host`     runs a configuration the PAIRED HOST owns. A local agent
 *                needs a shell that can spawn a process, and a browser tab is
 *                not one, so this is not interchangeable with `external`.
 */

import type { AgentRuntimeAdapterId } from "@cognia/agent-config-types/agent-execution"

export type AgentRuntimeRef =
  | {
      kind: "builtin"
      /**
       * Pin the sidecar runtime instead of deriving it from the provider.
       *
       * DELIBERATELY INERT in this release. No surface writes it, and
       * `deriveBuiltinAdapter` ignores a value that is set, because the
       * sidecar's dispatch still resolves its adapter from the frozen spec
       * that `runtimeFromLegacy` produces. The field exists so the shape
       * matches `TeammateExecutionBinding.runtimePolicy`
       * (`types/agent/agent-team.ts`), which offers exactly this pin one level
       * down. Honouring it is a resolver change, not a type change.
       *
       * Pinned by `types.test.ts` ("the builtin adapter pin is inert").
       */
      adapter?: AgentRuntimeAdapterId
    }
  | { kind: "external"; agentId: string }
  | {
      kind: "host"
      configId: string
      /**
       * Captured when the row is picked. The host admits the run against it, so
       * a configuration edited between the click and the send is refused rather
       * than run quietly.
       */
      revision: string
      lifecycleGeneration: number
      /**
       * Cached label, never sent anywhere. The host resolves what actually runs
       * from the stamp above. It exists because the host configuration list
       * loads asynchronously, and without a remembered label the composer chip
       * reads "External (none selected)" for the first frames after a reload,
       * on a selection that is perfectly valid.
       */
      name?: string
    }

/** The default lane: Cognia's own runtime, adapter derived per turn. */
export const BUILTIN_RUNTIME_REF: AgentRuntimeRef = { kind: "builtin" }

/**
 * Stable string form, used as the radio value, the test id suffix and the
 * telemetry label. Deliberately lossy for `host` (the revision and generation
 * are not in the key), so nothing may reconstruct a ref by parsing a key. Look
 * the descriptor up with {@link findRuntimeByKey} instead.
 */
export function runtimeRefKey(ref: AgentRuntimeRef): string {
  switch (ref.kind) {
    case "builtin":
      return "builtin"
    case "external":
      return `external:${ref.agentId}`
    case "host":
      return `host:${ref.configId}`
  }
}

/** Same lane AND same target. Revision changes do not make two refs different. */
export function isSameRuntimeRef(a: AgentRuntimeRef, b: AgentRuntimeRef): boolean {
  return runtimeRefKey(a) === runtimeRefKey(b)
}

/** One selectable row in the runtime catalog. */
export interface AgentRuntimeDescriptor {
  ref: AgentRuntimeRef
  key: string
  group: "builtin" | "external" | "host"
  /** User-authored name. Absent for the builtin lane, which is translated. */
  name?: string
  /** i18n key for the row title. Present only where the name is ours to write. */
  nameKey?: string
  /** i18n key for the row's sub-label. */
  descriptionKey?: string
  /** Interpolation values for {@link descriptionKey}. */
  descriptionValues?: Record<string, string>
  /**
   * The sidecar runtime that will really serve a `builtin` turn, derived from
   * the provider. This is the field that stops the row from claiming
   * "Anthropic SDK sidecar" on a DeepSeek session.
   */
  derivedAdapter?: AgentRuntimeAdapterId
  /** Wire protocol shown as a badge (`ACP`, `CODEX-APP-SERVER`, …). */
  protocolLabel?: string
  /** Brand icon id for the row glyph. */
  brandId?: string
  /**
   * Why this row cannot execute at all, derived from configuration alone, so it
   * is authoritative now and the row is not selectable.
   */
  blockedReason?: string
  /**
   * A block that may clear itself (a plugin adapter that has not registered
   * yet). The row still renders disabled, but a persisted selection pointing at
   * it must NOT be rewritten: doing that reset the user's plugin-backed agent
   * to the default on every restart.
   */
  blockTransient?: boolean
  /**
   * What the last real contact found (failed connect, pending sign-in, bad
   * health probe). History, not a verdict, so it warns and never blocks.
   */
  warning?: string
}

/** Look a descriptor up by its {@link runtimeRefKey}. */
export function findRuntimeByKey(
  descriptors: readonly AgentRuntimeDescriptor[],
  key: string
): AgentRuntimeDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.key === key)
}
