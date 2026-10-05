/**
 * Several configurations of one runtime, read as a family (ADR-0216).
 *
 * A user keeps a read-only Codex next to a workspace-write one, or one CLI on
 * two accounts. Every surface that lists them needs the same three answers,
 * and each one inline is how two lists end up disagreeing:
 *
 *   - **which configurations are the same runtime** (`runtimeFamilyKey`), so a
 *     list can group them and a picker can tell them apart;
 *   - **which of them share on-disk state** (`sharedStateSiblings`): two
 *     `shared` configurations of one runtime use one login, one CLI config file
 *     and one session history, so signing one out signs out both;
 *   - **what actually differs** between two of them (`instanceDifferences`), the
 *     line a list shows under a name that is otherwise identical.
 *
 * Pure: inputs in, data out. Labels are i18n keys for the caller to resolve.
 */

import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import { agentStateWritableRoots, baseCommandName } from "../policy/security-policy"
import { presetFamilyOf } from "./agent-binding"
import { externalAgentPresetIdOf } from "./preset-identity"

/** The fields this module reads. A stored config, a host record's config and a live one all fit. */
export type InstanceFamilyConfig = Pick<
  ExternalAgentConfig,
  | "id"
  | "name"
  | "protocol"
  | "transport"
  | "process"
  | "network"
  | "metadata"
  | "stateIsolation"
  | "defaultPermissionMode"
  | "cogniaModel"
  | "subscriptionAccountId"
  | "codexOptions"
  | "maxConcurrentSessions"
  | "autoApprovePatterns"
  | "requireApprovalFor"
  | "duplicatedFromAgentId"
>

/** What the add form records on `metadata.preset` for a hand-configured agent. */
const CUSTOM_PRESET_MARKER = "custom"

/**
 * The runtime a configuration runs, as one stable key.
 *
 * A preset answers first, through its family (`codex`, `codex-acp` and
 * `codex-app-server` are one runtime). The add form's `"custom"` marker names
 * no runtime: two hand-configured agents are one runtime only if they launch
 * the same thing. A hand-configured local agent is its
 * launch target (the package for `npx <package>`). A network agent is its
 * protocol plus endpoint origin: two agents on one server are one runtime.
 */
export function runtimeFamilyKey(config: InstanceFamilyConfig): string {
  const preset = externalAgentPresetIdOf(config)
  if (preset && preset !== CUSTOM_PRESET_MARKER) return `preset:${presetFamilyOf(preset)[0]}`
  if (config.transport === "stdio" && config.process?.command) {
    // The executable's own name: `/opt/homebrew/bin/codex` and `codex` are one runtime.
    const base = baseCommandName(config.process.command.split(/[\\/]/).at(-1) ?? "")
    const target =
      base === "npx" ? (config.process.args ?? []).find((arg) => !arg.startsWith("-")) : undefined
    return `command:${target ?? base}`
  }
  const endpoint = config.network?.endpoint?.trim()
  if (endpoint) {
    try {
      return `endpoint:${config.protocol}:${new URL(endpoint).origin}`
    } catch {
      return `endpoint:${config.protocol}:${endpoint}`
    }
  }
  return `protocol:${config.protocol}`
}

export interface RuntimeFamily<T extends InstanceFamilyConfig> {
  key: string
  members: T[]
}

/**
 * Group configurations by runtime, keeping the caller's order inside each
 * group and ordering groups by their first member.
 */
export function groupByRuntimeFamily<T extends InstanceFamilyConfig>(
  configs: readonly T[]
): RuntimeFamily<T>[] {
  const families = new Map<string, T[]>()
  for (const config of configs) {
    const key = runtimeFamilyKey(config)
    const members = families.get(key)
    if (members) members.push(config)
    else families.set(key, [config])
  }
  return Array.from(families, ([key, members]) => ({ key, members }))
}

/** Every other configuration of the same runtime, in the caller's order. */
export function runtimeSiblings<T extends InstanceFamilyConfig>(
  config: InstanceFamilyConfig,
  configs: readonly T[]
): T[] {
  const key = runtimeFamilyKey(config)
  return configs.filter((other) => other.id !== config.id && runtimeFamilyKey(other) === key)
}

/**
 * The configurations that read and write the same runtime state as this one.
 *
 * Only two `shared` local configurations can: an `isolated` one owns its root,
 * and a network agent keeps its state on the server, not in a home directory
 * Cognia can name. "Same state" is any overlapping writable state root, so a
 * hand-configured `codex` binary and the Codex preset are recognised as one
 * home.
 */
export function sharedStateSiblings<T extends InstanceFamilyConfig>(
  config: InstanceFamilyConfig,
  configs: readonly T[]
): T[] {
  const roots = sharedStateRoots(config)
  if (roots.length === 0) return []
  return configs.filter(
    (other) =>
      other.id !== config.id && sharedStateRoots(other).some((root) => roots.includes(root))
  )
}

function sharedStateRoots(config: InstanceFamilyConfig): string[] {
  if (config.stateIsolation === "isolated") return []
  if (config.transport !== "stdio" || !config.process?.command) return []
  // `.npm` is the package runner's cache, not anyone's login or history.
  return agentStateWritableRoots(config.process.command, config.process.args ?? []).filter(
    (root) => root !== ".npm"
  )
}

/** A field two configurations of one runtime can differ on. */
export type InstanceDifferenceKey =
  | "permissionMode"
  | "stateIsolation"
  | "model"
  | "account"
  | "workingDirectory"
  | "arguments"
  | "sandbox"
  | "network"
  | "endpoint"
  | "sessionLimit"
  | "approvals"

export interface InstanceDifference {
  key: InstanceDifferenceKey
  /** This configuration's value, display-ready but untranslated. `null` = not set. */
  value: string | null
  /** The other configuration's value. */
  otherValue: string | null
}

/**
 * The settings in which `config` differs from `other`, in a fixed order.
 *
 * Values are raw (a permission mode id, a path, a model id); the caller maps
 * the enum-like ones (`permissionMode`, `stateIsolation`, `sandbox`,
 * `network`) to labels.
 */
export function instanceDifferences(
  config: InstanceFamilyConfig,
  other: InstanceFamilyConfig
): InstanceDifference[] {
  const pairs: Array<[InstanceDifferenceKey, string | null, string | null]> = [
    ["permissionMode", config.defaultPermissionMode ?? null, other.defaultPermissionMode ?? null],
    ["stateIsolation", isolationOf(config), isolationOf(other)],
    ["model", modelOf(config), modelOf(other)],
    ["account", config.subscriptionAccountId ?? null, other.subscriptionAccountId ?? null],
    ["workingDirectory", config.process?.cwd || null, other.process?.cwd || null],
    ["arguments", argsOf(config), argsOf(other)],
    ["sandbox", config.codexOptions?.sandboxMode ?? null, other.codexOptions?.sandboxMode ?? null],
    ["network", networkOf(config), networkOf(other)],
    ["endpoint", config.network?.endpoint || null, other.network?.endpoint || null],
    ["sessionLimit", limitOf(config), limitOf(other)],
    ["approvals", approvalsOf(config), approvalsOf(other)],
  ]
  return pairs
    .filter(([, value, otherValue]) => value !== otherValue)
    .map(([key, value, otherValue]) => ({ key, value, otherValue }))
}

/**
 * What sets this configuration apart from the rest of its family: the keys on
 * which it differs from at least one sibling, with its own values. Empty when
 * it has no sibling, or no sibling differs.
 */
export function distinguishingTraits(
  config: InstanceFamilyConfig,
  siblings: readonly InstanceFamilyConfig[]
): Array<{ key: InstanceDifferenceKey; value: string | null }> {
  const keys = new Map<InstanceDifferenceKey, string | null>()
  for (const sibling of siblings) {
    for (const difference of instanceDifferences(config, sibling)) {
      if (!keys.has(difference.key)) keys.set(difference.key, difference.value)
    }
  }
  return Array.from(keys, ([key, value]) => ({ key, value }))
}

function isolationOf(config: InstanceFamilyConfig): string | null {
  // A network agent has no local state to isolate: the setting means nothing.
  if (config.transport !== "stdio") return null
  return config.stateIsolation ?? "shared"
}

function modelOf(config: InstanceFamilyConfig): string | null {
  const binding = config.cogniaModel
  return binding?.modelId ? `${binding.providerId}/${binding.modelId}` : null
}

function argsOf(config: InstanceFamilyConfig): string | null {
  const args = config.process?.args ?? []
  return args.length > 0 ? args.join(" ") : null
}

function networkOf(config: InstanceFamilyConfig): string | null {
  const access = config.codexOptions?.networkAccess
  return access === undefined ? null : access ? "on" : "off"
}

function limitOf(config: InstanceFamilyConfig): string | null {
  return config.maxConcurrentSessions ? String(config.maxConcurrentSessions) : null
}

function approvalsOf(config: InstanceFamilyConfig): string | null {
  const auto = config.autoApprovePatterns ?? []
  const ask = config.requireApprovalFor ?? []
  if (auto.length === 0 && ask.length === 0) return null
  return [...auto.map((entry) => `+${entry}`), ...ask.map((entry) => `?${entry}`)].join(" ")
}
