/**
 * Keep the active cogset in step with manual changes (ADR-0209).
 *
 * While a cogset is applied, the user can still toggle plugins and edit their
 * settings anywhere in the app. Each such change is written into the applied
 * cogset, so switching away and back restores what the user last had rather
 * than an older snapshot:
 *
 * - enabling a plugin makes it a member (unless it is always-on);
 * - disabling a member removes it; disabling an always-on plugin takes it out
 *   of the always-on set, since the user just said it should not run;
 * - editing a member's settings stores its non-secret config on the member.
 *
 * Changes the reconciliation makes itself are ignored: toggles carry the
 * `"cogset"` reason, and config applied during an activation happens while
 * `isCogsetReconciling()` is true.
 */

import { loggers } from "@cognia/logging"

import { stripSecretConfig } from "@/lib/plugin/core/config-secrets"
import type { PluginIntentChange } from "@/lib/plugin/core/plugin-intent-events"
import type { CogsetMember, CogsetRow, CogsetStateRow } from "@/types/plugin/plugin-cogset"

import { COGSET_TOGGLE_REASON } from "./reconcile"

export interface CogsetWriteThroughDeps {
  subscribeIntent: (listener: (change: PluginIntentChange) => void) => () => void
  subscribeConfig: (
    listener: (pluginId: string, config: Record<string, unknown>) => void
  ) => () => void
  getState: () => Promise<CogsetStateRow>
  updateState: (patch: { alwaysOn: string[] }) => Promise<unknown>
  getCogset: (id: string) => Promise<CogsetRow | undefined>
  updateCogset: (id: string, patch: { members: CogsetMember[] }) => Promise<unknown>
  getPluginManifest: (pluginId: string) => Promise<Record<string, unknown> | undefined>
  isReconciling: () => boolean
}

export interface CogsetWriteThrough {
  stop: () => void
  /** Resolves once every change observed so far has been written. */
  settled: () => Promise<void>
}

export function startCogsetWriteThrough(deps: CogsetWriteThroughDeps): CogsetWriteThrough {
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((error) => {
      loggers.plugin.warn("cogset write-through failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  async function onIntent(change: PluginIntentChange): Promise<void> {
    if (change.reason === COGSET_TOGGLE_REASON || change.intent === "auto") return
    const state = await deps.getState()
    if (!state.appliedCogsetId) return
    const cogset = await deps.getCogset(state.appliedCogsetId)
    if (!cogset) return
    const isMember = cogset.members.some((member) => member.pluginId === change.pluginId)

    if (change.intent === "enabled") {
      if (isMember || state.alwaysOn.includes(change.pluginId)) return
      await deps.updateCogset(cogset.id, {
        members: [...cogset.members, { pluginId: change.pluginId }],
      })
      return
    }
    if (isMember) {
      await deps.updateCogset(cogset.id, {
        members: cogset.members.filter((member) => member.pluginId !== change.pluginId),
      })
    }
    if (state.alwaysOn.includes(change.pluginId)) {
      await deps.updateState({ alwaysOn: state.alwaysOn.filter((id) => id !== change.pluginId) })
    }
  }

  async function onConfig(pluginId: string, config: Record<string, unknown>): Promise<void> {
    const state = await deps.getState()
    if (!state.appliedCogsetId) return
    const cogset = await deps.getCogset(state.appliedCogsetId)
    if (!cogset?.members.some((member) => member.pluginId === pluginId)) return
    const plain = stripSecretConfig(config, await deps.getPluginManifest(pluginId))
    await deps.updateCogset(cogset.id, {
      members: cogset.members.map((member) => {
        if (member.pluginId !== pluginId) return member
        const { config: _previous, ...rest } = member
        return Object.keys(plain).length > 0 ? { ...rest, config: plain } : rest
      }),
    })
  }

  const offIntent = deps.subscribeIntent((change) => enqueue(() => onIntent(change)))
  const offConfig = deps.subscribeConfig((pluginId, config) => {
    // Read the flag now: by the time the queued work runs the activation may
    // have finished, and its own config writes would then look manual.
    if (deps.isReconciling()) return
    enqueue(() => onConfig(pluginId, config))
  })

  return {
    stop: () => {
      offIntent()
      offConfig()
    },
    settled: async () => {
      await chain
    },
  }
}

/** The production wiring. */
export async function startDefaultCogsetWriteThrough(): Promise<CogsetWriteThrough> {
  const [intentEvents, configApi, cogsets, plugins, reconcile] = await Promise.all([
    import("@/lib/plugin/core/plugin-intent-events"),
    import("@/lib/plugin/api/config-api"),
    import("@/lib/db/plugin-cogsets"),
    import("@/lib/db/plugins"),
    import("./reconcile"),
  ])
  const { setActiveCogsetWriteThrough } = await import("./follower-registry")
  const writeThrough = startCogsetWriteThrough({
    subscribeIntent: intentEvents.subscribePluginIntentChanges,
    subscribeConfig: configApi.subscribeAnyPluginConfigChange,
    getState: cogsets.getCogsetState,
    updateState: (patch) => cogsets.updateCogsetState(patch),
    getCogset: cogsets.getCogset,
    updateCogset: (id, patch) => cogsets.updateCogset(id, patch),
    getPluginManifest: async (pluginId) => (await plugins.getPlugin(pluginId))?.manifest,
    isReconciling: reconcile.isCogsetReconciling,
  })
  setActiveCogsetWriteThrough(writeThrough)
  return {
    settled: writeThrough.settled,
    stop: () => {
      writeThrough.stop()
      setActiveCogsetWriteThrough(null)
    },
  }
}
