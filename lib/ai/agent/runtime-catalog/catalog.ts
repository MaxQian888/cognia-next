/**
 * The one list of "what can run the next turn".
 *
 * Pure: every input is passed in, nothing is read from a store or a shell
 * probe, so this suite runs in the fast node project. The React side lives in
 * `hooks/agent/use-agent-runtime-catalog.ts`, which does nothing but gather
 * these inputs.
 *
 * Why a catalog at all. Every other pluggable thing in this repo is one
 * (external protocols, external presets, subagents, MCP presets, hooks, teams),
 * and the first-party runtime was the single exception: a string literal in a
 * closed union, hardcoded in the store, the chip, the composer and the send
 * path. That is the one implementation that was not built on the extension
 * point, so it alone could not be enumerated, described, or health-reported the
 * way a third-party runtime could.
 */

import {
  getExternalAgentExecutionBlock,
  type ExternalAgentRuntimeReach,
} from "@/lib/ai/agent/external/config-normalizer"
import { isFromPreset } from "@/lib/ai/agent/external/presets"
import { runtimeFromLegacy } from "@/lib/ai/agent/execution/legacy-mapping"
import type { AgentRuntimeAdapterId } from "@cognia/agent-config-types/agent-execution"
import type {
  ExternalAgentConfig,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type { AgentRuntimeDescriptor } from "./types"
import { runtimeRefKey } from "./types"

/**
 * Which sidecar runtime a builtin turn really lands on.
 *
 * Delegates to `runtimeFromLegacy`, the same mapping the frozen execution spec
 * uses (`lib/claude/build-options.ts` stamps it on every send), so the label
 * cannot drift from what dispatch does. A ref that pins an adapter is ignored
 * on purpose, see `AgentRuntimeRef.adapter`.
 */
export function deriveBuiltinAdapter(providerId: string | undefined): AgentRuntimeAdapterId {
  const adapter = runtimeFromLegacy({ provider: providerId })
  // `runtimeFromLegacy` can also answer "external" (for a teammate runtime),
  // which is not a sidecar runtime and cannot describe the builtin lane. Chat
  // never passes that signal, but narrowing here rather than casting means a
  // future caller cannot label the builtin row with a lane it is not on.
  return adapter === "external" ? "claude-agent-sdk" : adapter
}

export interface AgentRuntimeCatalogInput {
  /** Provider the next turn will use. Decides the builtin row's sub-label. */
  providerId?: string
  /** The External Agents master switch. Off means no local rows at all. */
  externalEnabled: boolean
  /** Locally configured agents, already hydrated. */
  externalAgents: readonly ExternalAgentConfig[]
  /** Last known contact per agent id, from the manager's validity snapshots. */
  agentValidity?: Record<string, ExternalAgentValiditySnapshot | undefined>
  /** Configurations the paired host owns. Pass an empty list when unavailable. */
  hostConfigs?: readonly ExternalAgentConfigRecord[]
  /**
   * Whether an agent process can be started from here at all. Threaded rather
   * than probed so the module stays pure.
   *
   * A bare boolean is still accepted, and is what the tests pass, but a caller
   * that has the richer verdict should hand that over instead: the REASON is
   * what lets a row say "this device has no Agent Control" rather than the
   * flatly wrong "you need the desktop app", and it is what carries the
   * `transient` marker for a Host that is merely still handshaking. Collapsing
   * it to a boolean here made every companion look permanently blocked, and a
   * permanent block is what the selector treats as grounds to rewrite the
   * user's chosen runtime back to the default.
   */
  runtimeSupportsExternalAgents: ExternalAgentRuntimeReach
  /** Resolves a validity snapshot into the one-line warning. Injected for i18n. */
  describeWarning?: (validity: ExternalAgentValiditySnapshot | undefined) => string | null
}

/** The builtin lane, always first and always selectable. */
function builtinDescriptor(providerId: string | undefined): AgentRuntimeDescriptor {
  const derivedAdapter = deriveBuiltinAdapter(providerId)
  return {
    ref: { kind: "builtin" },
    key: "builtin",
    group: "builtin",
    nameKey: "cogniaAgent",
    // The sub-label names the runtime that will actually serve the turn. The
    // row used to read "Anthropic SDK sidecar" unconditionally, which was wrong
    // for every non-anthropic provider, and wrong exactly where a screen reader
    // and a first-time user look (the tooltip, the aria-label and the menu),
    // because the chip itself is glyph-only on this lane.
    descriptionKey: derivedAdapter === "claude-agent-sdk" ? "engineClaudeAgentSdk" : "engineAiSdk",
    ...(derivedAdapter === "ai-sdk" && providerId
      ? { descriptionValues: { provider: providerId } }
      : {}),
    derivedAdapter,
  }
}

/**
 * The builtin lane is available wherever chat itself is: on desktop it runs the
 * local sidecar, and on a companion shell `transport` routes the same call to
 * the paired host. So it carries no availability gate, unlike the local
 * external rows, which genuinely need a shell that can spawn a process.
 */
function externalDescriptors(input: AgentRuntimeCatalogInput): AgentRuntimeDescriptor[] {
  if (!input.externalEnabled) return []
  return [...input.externalAgents]
    .map((agent) => {
      const block = getExternalAgentExecutionBlock(agent, input.runtimeSupportsExternalAgents)
      const blockedReason = block?.reason ?? null
      const warning = blockedReason
        ? null
        : (input.describeWarning?.(input.agentValidity?.[agent.id]) ?? null)
      const ref = { kind: "external", agentId: agent.id } as const
      return {
        ref,
        key: runtimeRefKey(ref),
        group: "external" as const,
        name: agent.name,
        protocolLabel: agent.protocol.toUpperCase(),
        brandId: isFromPreset(agent) ?? agent.name,
        ...(blockedReason ? { blockedReason } : {}),
        ...(block?.transient === true ? { blockTransient: true } : {}),
        ...(warning ? { warning } : {}),
      }
    })
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
}

/**
 * Host-owned rows stay a separate group rather than merging with the local
 * ones. A local agent runs where this shell can spawn a process, and on a
 * browser that is nowhere, so presenting the two as interchangeable would be
 * the misleading part. Only ready, enabled configurations appear. The rest are
 * actionable on the settings page, not in a picker.
 */
function hostDescriptors(input: AgentRuntimeCatalogInput): AgentRuntimeDescriptor[] {
  return (input.hostConfigs ?? [])
    .filter((record) => record.enabled && record.lifecycleStatus === "ready")
    .map((record) => {
      const config = record.config as { name?: string; protocol?: string }
      const name = config.name ?? record.configId
      const ref = {
        kind: "host",
        configId: record.configId,
        revision: record.revision,
        lifecycleGeneration: record.lifecycleGeneration,
        name,
      } as const
      return {
        ref,
        key: runtimeRefKey(ref),
        group: "host" as const,
        name,
        ...(config.protocol ? { protocolLabel: config.protocol.toUpperCase() } : {}),
      }
    })
}

/**
 * Every runtime this shell can point the next turn at, builtin first.
 *
 * The builtin row is unconditional. A catalog that could return zero rows would
 * leave the composer with nothing to name, and "no runtime" is not a state chat
 * can be in.
 */
export function listAgentRuntimes(input: AgentRuntimeCatalogInput): AgentRuntimeDescriptor[] {
  return [
    builtinDescriptor(input.providerId),
    ...externalDescriptors(input),
    ...hostDescriptors(input),
  ]
}
