/**
 * What activating a cogset would do (ADR-0209). Pure: no Dexie, no manager.
 *
 * The target set is the cogset's members ∪ the always-on set ∪ the required
 * dependency closure of both. Everything installed and enabled outside it is
 * disabled (switching is exclusive); nothing is ever uninstalled. Enables run
 * in `resolveLoadOrder` order so a dependency is running before its dependent;
 * disables run dependents first for the same reason in reverse.
 *
 * Every problem is decided here, before anything changes, so the UI can show
 * the same answer the reconciliation will act on.
 */

import { canonicalizeJson } from "@/lib/plugin/character-pack/canonical-json"
import { mergeKeepingSecrets } from "@/lib/plugin/core/config-secrets"
import { resolveLoadOrder, type LoadOrderBlockReason } from "@/lib/plugin/core/load-order"
import type { CogsetMember, CogsetPluginOutcome } from "@/types/plugin/plugin-cogset"

/** The slice of an installed plugin the planner reads. */
export interface InstalledPluginView {
  id: string
  version: string
  enabled: boolean
  manifest: Record<string, unknown>
  config?: Record<string, unknown>
}

export interface CogsetPlanInput {
  members: readonly CogsetMember[]
  alwaysOn: readonly string[]
  installed: readonly InstalledPluginView[]
  /** True when this host cannot run the plugin at all (runtime profile gate). */
  isBlocked: (plugin: InstalledPluginView) => boolean
}

export interface CogsetConfigChange {
  pluginId: string
  config: Record<string, unknown>
}

export interface CogsetPlan {
  /** Plugins enabled once activation finishes, in enable order. */
  target: string[]
  /** Target plugins not enabled yet, in enable order. */
  enable: string[]
  /** Enabled plugins outside the target, dependents first. */
  disable: string[]
  /** Member config that differs from what the plugin has now. */
  configChanges: CogsetConfigChange[]
  /** Required dependencies pulled in that are neither members nor always-on. */
  addedDependencies: string[]
  /** Everything that will not reach the state the cogset asks for. */
  problems: CogsetPluginOutcome[]
}

type Deps = Record<string, string>

function readDeps(
  manifest: Record<string, unknown>,
  key: "dependencies" | "optionalDependencies"
): Deps {
  const value = manifest[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
}

function sameConfig(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  try {
    return canonicalizeJson(a) === canonicalizeJson(b)
  } catch {
    // A value canonical JSON cannot express is not one we can call unchanged.
    return false
  }
}

/** One blocked dependency as an outcome the UI can translate. */
function blockedOutcome(reason: LoadOrderBlockReason): Partial<CogsetPluginOutcome> {
  switch (reason.kind) {
    case "missing":
      return {
        reason: "dependency-missing",
        dependencyId: reason.dependencyId,
        dependencyConstraint: reason.constraint,
      }
    case "disabled":
      return { reason: "dependency-disabled", dependencyId: reason.dependencyId }
    case "version-mismatch":
      return {
        reason: "dependency-version",
        dependencyId: reason.dependencyId,
        dependencyConstraint: reason.constraint,
        dependencyFound: reason.found,
      }
    case "cycle":
      return { reason: "dependency-cycle", dependencyId: reason.dependencyId }
  }
}

export function planCogsetActivation(input: CogsetPlanInput): CogsetPlan {
  const installed = new Map(input.installed.map((plugin) => [plugin.id, plugin]))
  const members = new Map(input.members.map((member) => [member.pluginId, member]))
  const alwaysOn = new Set(input.alwaysOn)
  const problems: CogsetPluginOutcome[] = []

  // 1. What the user asked for, minus what is not installed.
  const wanted = new Set<string>([...members.keys(), ...alwaysOn])
  const requested = new Set<string>()
  for (const id of wanted) {
    if (installed.has(id)) {
      requested.add(id)
      continue
    }
    const member = members.get(id)
    problems.push({
      pluginId: id,
      action: "enable",
      ok: false,
      reason: "not-installed",
      // An always-on plugin that is gone is not this cogset's problem.
      optional: member ? !!member.optional : true,
    })
  }

  // 2. The required-dependency closure over installed plugins. Missing ones are
  //    left to `resolveLoadOrder`, which reports the dependent as blocked.
  const set = new Set(requested)
  const addedDependencies: string[] = []
  const queue = [...requested]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const depId of Object.keys(readDeps(installed.get(id)!.manifest, "dependencies"))) {
      if (set.has(depId) || !installed.has(depId)) continue
      set.add(depId)
      addedDependencies.push(depId)
      queue.push(depId)
    }
  }

  // 3. Plugins this host cannot run leave the set; their dependents then show
  //    up as blocked on a dependency, which is what they are.
  for (const id of [...set]) {
    const plugin = installed.get(id)!
    if (!input.isBlocked(plugin)) continue
    set.delete(id)
    problems.push({
      pluginId: id,
      action: "enable",
      ok: false,
      reason: "blocked",
      optional: !!members.get(id)?.optional || !members.has(id),
    })
  }

  // 4. Order, and whatever still cannot be satisfied.
  const order = resolveLoadOrder(
    [...set].map((id) => {
      const plugin = installed.get(id)!
      return {
        id,
        version: plugin.version,
        dependencies: readDeps(plugin.manifest, "dependencies"),
        optionalDependencies: readDeps(plugin.manifest, "optionalDependencies"),
        status: "installed" as const,
      }
    })
  )
  // One outcome per unmet dependency, so each can be shown and fixed.
  for (const [id, reasons] of order.blocked) {
    const optional = !!members.get(id)?.optional || (!members.has(id) && !alwaysOn.has(id))
    for (const reason of reasons) {
      problems.push({
        pluginId: id,
        action: "enable",
        ok: false,
        ...blockedOutcome(reason),
        optional,
      })
    }
  }
  for (const cycle of order.cycles) {
    for (const id of cycle) {
      if (order.blocked.has(id)) continue
      problems.push({
        pluginId: id,
        action: "enable",
        ok: false,
        reason: "dependency-cycle",
        cycle: [...cycle],
        optional: !!members.get(id)?.optional,
      })
    }
  }
  const target = order.order

  // 5. A member that will run, but not at the version the cogset pinned.
  for (const id of target) {
    const member = members.get(id)
    const plugin = installed.get(id)!
    if (member?.expectedVersion && member.expectedVersion !== plugin.version) {
      problems.push({
        pluginId: id,
        action: "enable",
        ok: false,
        reason: "version-mismatch",
        expectedVersion: member.expectedVersion,
        installedVersion: plugin.version,
        optional: !!member.optional,
      })
    }
  }

  // 6. Transitions.
  const targetSet = new Set(target)
  const enable = target.filter((id) => !installed.get(id)!.enabled)
  const currentlyEnabled = input.installed.filter((plugin) => plugin.enabled)
  const enabledOrder = resolveLoadOrder(
    currentlyEnabled.map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      dependencies: readDeps(plugin.manifest, "dependencies"),
      status: "installed" as const,
    }))
  ).order
  const disableOrder = [
    ...[...enabledOrder].reverse(),
    ...currentlyEnabled.map((plugin) => plugin.id).filter((id) => !enabledOrder.includes(id)),
  ]
  const disable = disableOrder.filter((id) => !targetSet.has(id))

  // 7. Config, with the plugin's own secrets kept whatever the cogset says.
  const configChanges: CogsetConfigChange[] = []
  for (const id of target) {
    const member = members.get(id)
    if (!member?.config) continue
    const plugin = installed.get(id)!
    const current = plugin.config ?? {}
    const next = mergeKeepingSecrets(member.config, current, plugin.manifest)
    if (!sameConfig(next, current)) configChanges.push({ pluginId: id, config: next })
  }

  return { target, enable, disable, configChanges, addedDependencies, problems }
}
