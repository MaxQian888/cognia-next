/**
 * What the user can do with cogsets (ADR-0209). The UI calls these; nothing
 * here renders.
 *
 * Cogsets are host-authoritative. A mirrored client (a paired phone, a browser
 * driving a host) can switch cogsets and nothing else: the switch is queued to
 * the host as `plugin_cogset_activate`, the host decides and reconciles, and
 * the mirror sees the result on its next sync. Editing is host-only, and the
 * UI says so (`isMirroredPluginClient`).
 */

import { getInstallOrigin } from "@/lib/db/plugin-install-origins"
import {
  createCogset,
  deleteCogset,
  getCogset,
  getCogsetState,
  listCogsets,
  updateCogset,
  updateCogsetState,
} from "@/lib/db/plugin-cogsets"
import { getPlugin, listPlugins } from "@/lib/db/plugins"
import { stripSecretConfig } from "@/lib/plugin/core/config-secrets"
import {
  isMirroredPluginClient,
  setPluginEnabledForHost,
} from "@/lib/plugin/core/set-plugin-enabled-for-host"
import { useCogsetSessionStore } from "@/stores/plugins/cogset-session-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { CogsetMember, CogsetRow, CogsetSource } from "@/types/plugin/plugin-cogset"

import { getActiveCogsetFollower } from "./follower-registry"
import {
  activateCogset,
  COGSET_TOGGLE_REASON,
  type CogsetActivationProgress,
  type CogsetActivationResult,
} from "./reconcile"

export class CogsetMirrorError extends Error {
  constructor() {
    super("Cogsets are edited on the host this client mirrors")
    this.name = "CogsetMirrorError"
  }
}

function requireHost(): void {
  if (isMirroredPluginClient()) throw new CogsetMirrorError()
}

function activeWorkspaceBinding(): { projectId: string | null; cogsetId?: string } {
  const { activeProjectId, projects } = useProjectStore.getState()
  const active = projects.find((project) => project.id === activeProjectId)
  return { projectId: activeProjectId, cogsetId: active?.pluginCogsetId }
}

/**
 * Record the switch in the right scope. With a workspace binding in force, a
 * switch to another cogset is a session override (the workspace keeps its
 * binding); switching back to the bound one, or switching without a binding,
 * clears the override and — without a binding — becomes the global choice.
 */
async function recordSwitch(cogsetId: string): Promise<void> {
  const session = useCogsetSessionStore.getState()
  const binding = activeWorkspaceBinding().cogsetId
  if (binding && (await getCogset(binding))) {
    if (binding === cogsetId) session.clearOverride()
    else session.setOverride(cogsetId)
    return
  }
  session.clearOverride()
  await updateCogsetState({ globalCogsetId: cogsetId })
}

export interface SwitchCogsetResult {
  /** True on a mirrored client: the host will apply it. */
  queued: boolean
  result?: CogsetActivationResult
}

/**
 * The user picked a cogset. On the host this records the scope and reconciles
 * now; the caller has already asked the user if agent runs are in flight.
 */
export async function switchCogset(
  cogsetId: string,
  options: { onProgress?: (progress: CogsetActivationProgress) => void } = {}
): Promise<SwitchCogsetResult> {
  if (isMirroredPluginClient()) {
    const { queueCogsetActivation } = await import("./remote")
    await queueCogsetActivation(cogsetId)
    return { queued: true }
  }
  if (!(await getCogset(cogsetId))) throw new Error(`Cogset ${cogsetId} does not exist`)
  await recordSwitch(cogsetId)
  return { queued: false, result: await activateCogset(cogsetId, options) }
}

/**
 * A switch requested by a mirrored client, executed on the host. Recorded in
 * the same scope as a local switch, then left to the follower, which defers it
 * while agent runs are in flight — there is nobody at the host to ask.
 */
export async function switchCogsetFromRemote(cogsetId: string): Promise<void> {
  if (!(await getCogset(cogsetId))) throw new Error(`Cogset ${cogsetId} does not exist`)
  await recordSwitch(cogsetId)
  const follower = getActiveCogsetFollower()
  if (follower) await follower.evaluate()
}

/** Re-run the applied cogset, e.g. after fixing what made it partial. */
export async function retryAppliedCogset(
  options: { onProgress?: (progress: CogsetActivationProgress) => void } = {}
): Promise<CogsetActivationResult | null> {
  requireHost()
  const state = await getCogsetState()
  if (!state.appliedCogsetId) return null
  return activateCogset(state.appliedCogsetId, options)
}

/** Make `cogsetId` the global choice without switching the current session. */
export async function setGlobalCogset(cogsetId: string): Promise<void> {
  requireHost()
  if (!(await getCogset(cogsetId))) throw new Error(`Cogset ${cogsetId} does not exist`)
  await updateCogsetState({ globalCogsetId: cogsetId })
}

/** Bind a workspace to a cogset, or unbind it with `undefined`. */
export async function setWorkspaceCogset(
  projectId: string,
  cogsetId: string | undefined
): Promise<void> {
  requireHost()
  if (cogsetId && !(await getCogset(cogsetId))) {
    throw new Error(`Cogset ${cogsetId} does not exist`)
  }
  useProjectStore.getState().updateProject(projectId, { pluginCogsetId: cogsetId })
}

/**
 * Put a plugin in or out of the always-on set. The applied cogset is kept
 * consistent with what runs: turning always-on on enables the plugin and
 * drops it from the cogset (always-on covers it); turning it off leaves the
 * plugin running and makes it a member, so nothing changes until the user
 * switches.
 */
export async function setPluginAlwaysOn(pluginId: string, on: boolean): Promise<void> {
  requireHost()
  const state = await getCogsetState()
  const applied = state.appliedCogsetId ? await getCogset(state.appliedCogsetId) : undefined
  if (on) {
    await updateCogsetState({ alwaysOn: [...state.alwaysOn, pluginId] })
    if (applied?.members.some((member) => member.pluginId === pluginId)) {
      await updateCogset(applied.id, {
        members: applied.members.filter((member) => member.pluginId !== pluginId),
      })
    }
    const row = await getPlugin(pluginId)
    if (row && !row.enabled) {
      const result = await setPluginEnabledForHost(pluginId, true, COGSET_TOGGLE_REASON)
      if (!result.ok) throw new Error(result.error ?? `Could not enable ${pluginId}`)
    }
    return
  }
  await updateCogsetState({ alwaysOn: state.alwaysOn.filter((id) => id !== pluginId) })
  const row = await getPlugin(pluginId)
  if (applied && row?.enabled && !applied.members.some((member) => member.pluginId === pluginId)) {
    await updateCogset(applied.id, { members: [...applied.members, { pluginId }] })
  }
}

/** Create a cogset from chosen plugins (the editor, a marketplace preset). */
export async function createCogsetFromPlugins(input: {
  name: string
  description?: string
  pluginIds: readonly string[]
  source: CogsetSource
}): Promise<CogsetRow> {
  requireHost()
  const rows = await Promise.all(input.pluginIds.map((id) => getPlugin(id)))
  const members = rows.map((row, index) => {
    const pluginId = input.pluginIds[index]
    if (!row) return { pluginId }
    const config = stripSecretConfig(row.config, row.manifest)
    return Object.keys(config).length > 0 ? { pluginId, config } : { pluginId }
  })
  return createCogset({
    name: input.name,
    description: input.description,
    members,
    source: input.source,
  })
}

export async function editCogset(
  id: string,
  patch: { name?: string; description?: string; members?: CogsetMember[] }
): Promise<CogsetRow | undefined> {
  requireHost()
  return updateCogset(id, patch)
}

export class CogsetInUseError extends Error {
  constructor(readonly reason: "applied" | "global") {
    super(
      reason === "applied"
        ? "Switch to another cogset before deleting this one"
        : "Choose another default cogset before deleting this one"
    )
    this.name = "CogsetInUseError"
  }
}

/**
 * Delete a cogset. Refuses the applied and the global one, so the host always
 * has something to run. Never uninstalls; see {@link listPluginsOnlyIn}.
 */
export async function removeCogset(id: string): Promise<void> {
  requireHost()
  const state = await getCogsetState()
  if (state.appliedCogsetId === id) throw new CogsetInUseError("applied")
  if (state.globalCogsetId === id) throw new CogsetInUseError("global")
  if (useCogsetSessionStore.getState().overrideCogsetId === id) {
    useCogsetSessionStore.getState().clearOverride()
  }
  await deleteCogset(id)
}

/**
 * Installed plugins that only `cogsetId` uses: no other cogset lists them, they
 * are not always-on, and they did not ship with the app. These are the ones the
 * UI offers to uninstall when the cogset goes.
 */
export async function listPluginsOnlyIn(cogsetId: string): Promise<string[]> {
  const [cogsets, state, rows] = await Promise.all([listCogsets(), getCogsetState(), listPlugins()])
  const target = cogsets.find((cogset) => cogset.id === cogsetId)
  if (!target) return []
  const usedElsewhere = new Set<string>(state.alwaysOn)
  for (const cogset of cogsets) {
    if (cogset.id === cogsetId) continue
    for (const member of cogset.members) usedElsewhere.add(member.pluginId)
  }
  const installed = new Map(rows.map((row) => [row.id, row]))
  const result: string[] = []
  for (const member of target.members) {
    const row = installed.get(member.pluginId)
    if (!row || usedElsewhere.has(member.pluginId) || row.source === "builtin") continue
    const origin = await getInstallOrigin(member.pluginId)
    if (origin?.origin.kind === "builtin") continue
    result.push(member.pluginId)
  }
  return result
}
