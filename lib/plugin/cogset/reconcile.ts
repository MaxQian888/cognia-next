/**
 * Activate a cogset: reconcile this host's plugins to it (ADR-0209).
 *
 * The cogset owns what *should* run; `PluginManager.setPluginIntent` owns what
 * does. Activation is therefore a reconciliation that goes through the same
 * enable/disable path as every manual toggle — never a write to
 * `plugins.enabled` — in the order the planner decided:
 *
 *   1. save the outgoing cogset's members' current non-secret config into it,
 *      so every cogset keeps its own configuration;
 *   2. disable what the new cogset does not run (dependents first);
 *   3. apply member config (the plugin's own secrets kept);
 *   4. enable in dependency order.
 *
 * Each plugin's result is recorded. A failure leaves that plugin where the
 * manager left it and marks the cogset `partial`; nothing that switched
 * successfully is rolled back, and Retry re-runs the reconciliation.
 *
 * Activations are serialized: a second request waits for the first.
 */

import { stripSecretConfig } from "@/lib/plugin/core/config-secrets"
import type {
  CogsetAppliedState,
  CogsetMember,
  CogsetPluginOutcome,
  CogsetRow,
  CogsetStateRow,
} from "@/types/plugin/plugin-cogset"

import { planCogsetActivation, type CogsetPlan, type InstalledPluginView } from "./plan"

/** The reason every cogset-driven toggle carries; the write-through ignores it. */
export const COGSET_TOGGLE_REASON = "cogset"

export interface CogsetReconcileDeps {
  getCogset: (id: string) => Promise<CogsetRow | undefined>
  updateCogset: (
    id: string,
    patch: Partial<Pick<CogsetRow, "members" | "lastApplied">>
  ) => Promise<unknown>
  getState: () => Promise<CogsetStateRow>
  updateState: (patch: Partial<Omit<CogsetStateRow, "id" | "updatedAt">>) => Promise<CogsetStateRow>
  listInstalled: () => Promise<InstalledPluginView[]>
  setEnabled: (pluginId: string, next: boolean) => Promise<{ ok: boolean; error?: string }>
  applyConfig: (pluginId: string, config: Record<string, unknown>) => Promise<void>
  isBlocked: (plugin: InstalledPluginView) => boolean
  /**
   * Resolves once queued manual changes are written into the applied cogset,
   * so step 1 does not overwrite them with an older member list.
   */
  settleWriteThrough?: () => Promise<void>
  now: () => number
}

export interface CogsetActivationProgress {
  done: number
  total: number
  pluginId?: string
}

export interface ActivateCogsetOptions {
  onProgress?: (progress: CogsetActivationProgress) => void
  deps?: CogsetReconcileDeps
}

export interface CogsetActivationResult {
  cogsetId: string
  plan: CogsetPlan
  applied: CogsetAppliedState
}

let queue: Promise<unknown> = Promise.resolve()
let reconcilingDepth = 0
let inFlightTarget: string | null = null

/** True while an activation is applying changes; config observers ignore them. */
export function isCogsetReconciling(): boolean {
  return reconcilingDepth > 0
}

/** The cogset an activation is currently moving to, if any. */
export function cogsetActivationTarget(): string | null {
  return inFlightTarget
}

async function defaultDeps(): Promise<CogsetReconcileDeps> {
  const [
    cogsets,
    plugins,
    { togglePluginEnabled },
    { applyPluginConfig },
    { collectPluginRuntimeProfileDiagnostics },
    { currentRuntimeProfile },
    { getActiveCogsetWriteThrough },
  ] = await Promise.all([
    import("@/lib/db/plugin-cogsets"),
    import("@/lib/db/plugins"),
    import("@/lib/plugin/core/toggle-plugin-enabled"),
    import("@/lib/plugin/core/apply-plugin-config"),
    import("@/lib/plugin/core/runtime-compatibility"),
    import("@/lib/plugin/character-pack/platform-availability"),
    import("./follower-registry"),
  ])
  const profile = currentRuntimeProfile()
  return {
    getCogset: cogsets.getCogset,
    updateCogset: cogsets.updateCogset,
    getState: cogsets.getCogsetState,
    updateState: cogsets.updateCogsetState,
    listInstalled: async () =>
      (await plugins.listPlugins()).map((row) => ({
        id: row.id,
        version: row.version,
        enabled: row.enabled,
        manifest: row.manifest,
        config: row.config,
      })),
    setEnabled: (pluginId, next) => togglePluginEnabled(pluginId, next, COGSET_TOGGLE_REASON),
    applyConfig: (pluginId, config) => applyPluginConfig(pluginId, config),
    isBlocked: (plugin) =>
      collectPluginRuntimeProfileDiagnostics(plugin.manifest as never, profile).some(
        (diagnostic) => diagnostic.severity === "error"
      ),
    settleWriteThrough: async () => {
      await getActiveCogsetWriteThrough()?.settled()
    },
    now: Date.now,
  }
}

/** Members with their current non-secret config captured. */
function captureMemberConfig(
  members: readonly CogsetMember[],
  installed: ReadonlyMap<string, InstalledPluginView>
): CogsetMember[] {
  return members.map((member) => {
    const plugin = installed.get(member.pluginId)
    if (!plugin) return member
    const config = stripSecretConfig(plugin.config, plugin.manifest)
    const { config: _previous, ...rest } = member
    return Object.keys(config).length > 0 ? { ...rest, config } : rest
  })
}

async function run(
  cogsetId: string,
  deps: CogsetReconcileDeps,
  onProgress: ActivateCogsetOptions["onProgress"]
): Promise<CogsetActivationResult> {
  // Manual toggles queued before this switch land first; reading the cogsets
  // earlier would capture a member list they are about to change.
  await deps.settleWriteThrough?.()
  const cogset = await deps.getCogset(cogsetId)
  if (!cogset) throw new Error(`Cogset ${cogsetId} does not exist`)
  const state = await deps.getState()
  const installed = await deps.listInstalled()

  // 1. The outgoing cogset keeps the config its members have now.
  if (state.appliedCogsetId && state.appliedCogsetId !== cogsetId) {
    const outgoing = await deps.getCogset(state.appliedCogsetId)
    if (outgoing) {
      const byId = new Map(installed.map((plugin) => [plugin.id, plugin]))
      await deps.updateCogset(outgoing.id, { members: captureMemberConfig(outgoing.members, byId) })
    }
  }

  const plan = planCogsetActivation({
    members: cogset.members,
    alwaysOn: state.alwaysOn,
    installed,
    isBlocked: deps.isBlocked,
  })
  const outcomes: CogsetPluginOutcome[] = [...plan.problems]
  const total = plan.disable.length + plan.configChanges.length + plan.enable.length
  let done = 0
  const step = (pluginId: string) => {
    done += 1
    onProgress?.({ done, total, pluginId })
  }
  onProgress?.({ done, total })

  // 2. Disable, dependents first.
  for (const pluginId of plan.disable) {
    const result = await deps.setEnabled(pluginId, false)
    outcomes.push(
      result.ok
        ? { pluginId, action: "disable", ok: true }
        : {
            pluginId,
            action: "disable",
            ok: false,
            reason: "disable-failed",
            message: result.error,
          }
    )
    step(pluginId)
  }

  // 3. Config before enable, so a plugin starts with the cogset's settings.
  const configFailed = new Set<string>()
  for (const change of plan.configChanges) {
    try {
      await deps.applyConfig(change.pluginId, change.config)
      outcomes.push({ pluginId: change.pluginId, action: "config", ok: true })
    } catch (error) {
      configFailed.add(change.pluginId)
      outcomes.push({
        pluginId: change.pluginId,
        action: "config",
        ok: false,
        reason: "config-failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
    step(change.pluginId)
  }

  // 4. Enable in dependency order.
  for (const pluginId of plan.enable) {
    const result = await deps.setEnabled(pluginId, true)
    outcomes.push(
      result.ok
        ? { pluginId, action: "enable", ok: true }
        : { pluginId, action: "enable", ok: false, reason: "enable-failed", message: result.error }
    )
    step(pluginId)
  }
  for (const pluginId of plan.target) {
    if (!plan.enable.includes(pluginId) && !configFailed.has(pluginId)) {
      outcomes.push({ pluginId, action: "keep", ok: true })
    }
  }

  const at = deps.now()
  const applied: CogsetAppliedState = {
    status: outcomes.some((outcome) => !outcome.ok && !outcome.optional) ? "partial" : "applied",
    at,
    outcomes,
  }
  await deps.updateCogset(cogsetId, { lastApplied: applied })
  await deps.updateState({ appliedCogsetId: cogsetId, appliedAt: at, pending: undefined })
  return { cogsetId, plan, applied }
}

/**
 * Reconcile this host to `cogsetId`. Throws only when the cogset does not
 * exist or the state cannot be read; per-plugin failures are in the result.
 */
export function activateCogset(
  cogsetId: string,
  options: ActivateCogsetOptions = {}
): Promise<CogsetActivationResult> {
  const next = queue.then(async () => {
    const deps = options.deps ?? (await defaultDeps())
    reconcilingDepth += 1
    inFlightTarget = cogsetId
    try {
      return await run(cogsetId, deps, options.onProgress)
    } finally {
      reconcilingDepth -= 1
      if (reconcilingDepth === 0) inFlightTarget = null
    }
  })
  // The queue survives a failed activation; the caller still sees the error.
  queue = next.catch(() => undefined)
  return next
}
