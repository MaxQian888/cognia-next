/**
 * Import a cogpack (ADR-0209): plan, one review, then install.
 *
 * `planCogpackImport` does everything that can be known before anything
 * changes: verifies the file (inside `inspectCogpack`), resolves trust under
 * the plugin policy, previews every member at its pinned revision, compares
 * with what is installed, gathers the permissions, missing binaries and
 * conflicts the review shows, lists required dependencies the cogpack does not
 * carry, lists what activating the result would turn off, and — when this
 * cogpack was imported before — diffs against that import.
 *
 * `applyCogpackImport` installs what the user approved through the existing
 * per-source installers, writes the secrets the user typed, and creates (or
 * updates) the cogset. It never activates: switching is offered separately.
 * A member that could not be installed stays in the cogset and is listed as
 * missing, so the cogset is never quietly smaller than the cogpack.
 */

import { APP_VERSION } from "@/lib/app-version"
import { newCogpackInstallId } from "@/lib/db/cogpack-installs"
import type { PluginRow } from "@/lib/db/plugin-types"
import { planCogsetActivation, type InstalledPluginView } from "@/lib/plugin/cogset/plan"
import { listSecretConfigFields } from "@/lib/plugin/core/config-secrets"
import type {
  PreInstallBinaryPayload,
  PreInstallConflict,
} from "@/lib/plugin/marketplace/install-flow"
import { compareVersions, satisfiesConstraint } from "@/lib/plugin/package/dependency-resolver"
import type { WasmCapabilityGrantDecision } from "@/lib/plugin/security/wasm-grant"
import type { PluginManifest, PluginPermission } from "@/types/plugin"
import type {
  CogpackInstallRow,
  CogpackMember,
  CogpackProvenance,
  CogsetMember,
  CogsetRow,
  CogsetStateRow,
} from "@/types/plugin/plugin-cogset"

import type { InspectedCogpack } from "./package"
import type { CogpackUnavailableReason, InstalledByResolver, MemberResolution } from "./resolvers"
import type { CogpackTrustResult } from "./trust"
import {
  cogsetMemberFromCogpack,
  diffCogpackUpdate,
  mergeCogpackUpdate,
  type CogpackUpdateEntry,
} from "./update-diff"

export type CogpackMemberStatus = "same" | "different-version" | "new" | "unavailable"

export interface CogpackImportMemberPlan {
  member: CogpackMember
  status: CogpackMemberStatus
  installedVersion?: string
  manifest?: PluginManifest
  unavailable?: MemberResolution["unavailable"]
  /** What the review pre-selects: install the cogpack's revision or not. */
  installByDefault: boolean
  permissions: PluginPermission[]
  optionalPermissions: PluginPermission[]
  networkAccess?: PluginManifest["networkAccess"]
  missingBinaries: PreInstallBinaryPayload["missing"]
  conflicts: PreInstallConflict["reasons"]
  /** Secret fields to fill in: declared by the cogpack and the plugin itself. */
  secretFields: string[]
  /** A git member: its capabilities can only be reviewed once installed. */
  reviewAfterInstall: boolean
  /** @internal The pinned install, when there is one. */
  install?: MemberResolution["install"]
}

export interface CogpackMissingDependency {
  /** The member that requires it. */
  pluginId: string
  dependencyId: string
  constraint: string
  /** Installed at a version that does not satisfy the constraint. */
  installedVersion?: string
}

export interface CogpackImportPlan {
  inspected: InspectedCogpack
  trust: CogpackTrustResult
  compatibility: { minHostVersion: string; hostVersion: string; satisfied: boolean }
  members: CogpackImportMemberPlan[]
  missingDependencies: CogpackMissingDependency[]
  /** Installed plugins that activating the imported cogset would turn off. */
  disabledOnActivation: string[]
  /** Present when this cogpack was imported before and its cogset still exists. */
  update?: { install: CogpackInstallRow; cogset: CogsetRow; entries: CogpackUpdateEntry[] }
}

export interface CogpackImportPlanDeps {
  inspect: (bytes: Uint8Array) => Promise<InspectedCogpack>
  resolveTrust: (
    signature: InspectedCogpack["manifest"]["signature"]
  ) => Promise<CogpackTrustResult>
  resolveMember: (
    member: CogpackMember,
    embedded: ReadonlyMap<string, Uint8Array> | undefined
  ) => Promise<MemberResolution>
  listInstalled: () => Promise<PluginRow[]>
  getState: () => Promise<CogsetStateRow>
  isBlocked: (plugin: InstalledPluginView) => boolean
  detectConflicts: (
    pluginId: string,
    manifest: PluginManifest
  ) => Promise<PreInstallConflict | null>
  missingBinaries: (manifest: PluginManifest) => Promise<PreInstallBinaryPayload["missing"]>
  listPreviousInstalls: (cogpackId: string) => Promise<CogpackInstallRow[]>
  getCogset: (id: string) => Promise<CogsetRow | undefined>
  appVersion: string
}

async function defaultPlanDeps(): Promise<CogpackImportPlanDeps> {
  const [
    { inspectCogpack },
    { resolveCogpackTrust },
    { resolveCogpackMember },
    { listPlugins },
    cogsets,
    installFlow,
    { collectPluginRuntimeProfileDiagnostics },
    { currentRuntimeProfile },
    { listCogpackInstallsFor },
  ] = await Promise.all([
    import("./package"),
    import("./trust"),
    import("./resolvers"),
    import("@/lib/db/plugins"),
    import("@/lib/db/plugin-cogsets"),
    import("@/lib/plugin/marketplace/install-flow"),
    import("@/lib/plugin/core/runtime-compatibility"),
    import("@/lib/plugin/character-pack/platform-availability"),
    import("@/lib/db/cogpack-installs"),
  ])
  const profile = currentRuntimeProfile()
  return {
    inspect: inspectCogpack,
    resolveTrust: (signature) => resolveCogpackTrust(signature),
    resolveMember: resolveCogpackMember,
    listInstalled: listPlugins,
    getState: cogsets.getCogsetState,
    isBlocked: (plugin) =>
      collectPluginRuntimeProfileDiagnostics(plugin.manifest as never, profile).some(
        (diagnostic) => diagnostic.severity === "error"
      ),
    detectConflicts: installFlow.detectConflicts,
    missingBinaries: (manifest) =>
      installFlow.resolveMissingBinaries(manifest, installFlow.defaultDetectBinary),
    listPreviousInstalls: listCogpackInstallsFor,
    getCogset: cogsets.getCogset,
    appVersion: APP_VERSION,
  }
}

function viewOf(row: PluginRow): InstalledPluginView {
  return {
    id: row.id,
    version: row.version,
    enabled: row.enabled,
    manifest: row.manifest,
    config: row.config,
  }
}

export async function planCogpackImport(
  bytes: Uint8Array,
  deps?: CogpackImportPlanDeps
): Promise<CogpackImportPlan> {
  const d = deps ?? (await defaultPlanDeps())
  const inspected = await d.inspect(bytes)
  const { manifest } = inspected
  const trust = await d.resolveTrust(manifest.signature)
  const installedRows = await d.listInstalled()
  const installed = new Map(installedRows.map((row) => [row.id, row]))
  const memberIds = new Set(manifest.members.map((member) => member.id))

  const members: CogpackImportMemberPlan[] = []
  for (const member of manifest.members) {
    const row = installed.get(member.id)
    const resolution = await d.resolveMember(member, inspected.embedded.get(member.id))
    const manifestForReview =
      resolution.manifest ?? (row?.manifest as unknown as PluginManifest | undefined)
    let status: CogpackMemberStatus
    if (row && row.version === member.version) status = "same"
    else if (resolution.unavailable) status = "unavailable"
    else if (row) status = "different-version"
    else status = "new"
    const installs = status === "new" || status === "different-version"
    const conflict =
      installs && resolution.manifest
        ? await d.detectConflicts(member.id, resolution.manifest)
        : null
    members.push({
      member,
      status,
      ...(row ? { installedVersion: row.version } : {}),
      ...(manifestForReview ? { manifest: manifestForReview } : {}),
      ...(resolution.unavailable ? { unavailable: resolution.unavailable } : {}),
      installByDefault: installs && !!resolution.install,
      permissions: installs ? (resolution.manifest?.permissions ?? []) : [],
      optionalPermissions: installs ? (resolution.manifest?.optionalPermissions ?? []) : [],
      ...(installs && resolution.manifest?.networkAccess
        ? { networkAccess: resolution.manifest.networkAccess }
        : {}),
      missingBinaries:
        installs && resolution.manifest ? await d.missingBinaries(resolution.manifest) : [],
      // Already installed under that id is expected for an update; only other clashes matter.
      conflicts: (conflict?.reasons ?? []).filter(
        (reason) => !reason.message.startsWith("alreadyInstalled:")
      ),
      secretFields: [
        ...new Set([...(member.secretFields ?? []), ...listSecretConfigFields(manifestForReview)]),
      ].sort(),
      reviewAfterInstall: installs && !resolution.manifest && !!resolution.install,
      ...(resolution.install ? { install: resolution.install } : {}),
    })
  }

  // Required dependencies the cogpack does not carry, and installed ones it
  // does not satisfy. Shown, never installed behind the user's back.
  const missingDependencies: CogpackMissingDependency[] = []
  for (const plan of members) {
    const deps = (plan.manifest?.dependencies ?? {}) as Record<string, string>
    for (const [dependencyId, constraint] of Object.entries(deps)) {
      if (memberIds.has(dependencyId)) continue
      const row = installed.get(dependencyId)
      if (!row) {
        missingDependencies.push({ pluginId: plan.member.id, dependencyId, constraint })
      } else if (!satisfiesConstraint(row.version, constraint)) {
        missingDependencies.push({
          pluginId: plan.member.id,
          dependencyId,
          constraint,
          installedVersion: row.version,
        })
      }
    }
  }

  const state = await d.getState()
  const disabledOnActivation = planCogsetActivation({
    members: manifest.members.map(cogsetMemberFromCogpack),
    alwaysOn: state.alwaysOn,
    installed: installedRows.map(viewOf),
    isBlocked: d.isBlocked,
  }).disable

  let update: CogpackImportPlan["update"]
  for (const previous of await d.listPreviousInstalls(manifest.id)) {
    const cogset = await d.getCogset(previous.cogsetId)
    if (!cogset) continue
    update = {
      install: previous,
      cogset,
      entries: diffCogpackUpdate(previous.manifest, manifest, cogset),
    }
    break
  }

  return {
    inspected,
    trust,
    compatibility: {
      minHostVersion: manifest.compatibility.minHostVersion,
      hostVersion: d.appVersion,
      satisfied: compareVersions(d.appVersion, manifest.compatibility.minHostVersion) >= 0,
    },
    members,
    missingDependencies,
    disabledOnActivation,
    ...(update ? { update } : {}),
  }
}

export interface CogpackImportChoices {
  /** Plugin ids to install at the cogpack's revision. */
  install: ReadonlySet<string>
  /** Plugin id → secret field → value the user typed. Never stored in the cogset. */
  secrets: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Add the signer to the trusted publishers. */
  trustSigner: boolean
  /** Create a new cogset, or update the one the earlier import created. */
  mode: "new" | "update"
  /** Update mode: locally edited plugins for which the new version wins. */
  useNext: ReadonlySet<string>
}

/** Why a member of an imported cogpack is not installed. */
export type CogpackMissingReason =
  CogpackUnavailableReason | "install-failed" | "skipped" | "unavailable"

export interface CogpackImportResult {
  installId: string
  cogsetId: string
  installed: string[]
  failed: Array<{ pluginId: string; message: string }>
  missing: Array<{ pluginId: string; reason: CogpackMissingReason }>
  /** Git WASM members whose capabilities the user still has to review. */
  grantsToReview: NonNullable<InstalledByResolver["grantToReview"]>[]
}

export class CogpackRefusedError extends Error {
  constructor(readonly refusedBy: NonNullable<CogpackTrustResult["refusedBy"]>) {
    super(`The plugin policy refuses this cogpack (${refusedBy})`)
    this.name = "CogpackRefusedError"
  }
}

export interface CogpackImportApplyDeps {
  /** Re-run discovery so installs that land on disk get their rows. */
  rescan: () => Promise<void>
  getPlugin: (id: string) => Promise<PluginRow | undefined>
  applyConfig: (pluginId: string, config: Record<string, unknown>) => Promise<void>
  createCogset: (draft: {
    name: string
    description?: string
    members: CogsetMember[]
    source: CogsetRow["source"]
  }) => Promise<CogsetRow>
  updateCogset: (
    id: string,
    patch: { members?: CogsetMember[]; source?: CogsetRow["source"] }
  ) => Promise<unknown>
  putInstall: (row: CogpackInstallRow) => Promise<void>
  trustSigner: (signature: NonNullable<InspectedCogpack["manifest"]["signature"]>) => Promise<void>
  defaultGrant: (manifest: PluginManifest) => WasmCapabilityGrantDecision
  newInstallId: () => string
  now: () => number
}

async function defaultApplyDeps(): Promise<CogpackImportApplyDeps> {
  const [cogsets, installs, plugins, { applyPluginConfig }, { trustCogpackSigner }, wasmGrant] =
    await Promise.all([
      import("@/lib/db/plugin-cogsets"),
      import("@/lib/db/cogpack-installs"),
      import("@/lib/db/plugins"),
      import("@/lib/plugin/core/apply-plugin-config"),
      import("./trust"),
      import("@/lib/plugin/security/wasm-grant"),
    ])
  return {
    rescan: async () => {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().scanPlugins()
    },
    getPlugin: plugins.getPlugin,
    applyConfig: (pluginId, config) => applyPluginConfig(pluginId, config),
    createCogset: (draft) => cogsets.createCogset(draft),
    updateCogset: (id, patch) => cogsets.updateCogset(id, patch),
    putInstall: installs.putCogpackInstall,
    trustSigner: trustCogpackSigner,
    defaultGrant: (manifest) => wasmGrant.defaultWasmGrantDecision(manifest),
    newInstallId: newCogpackInstallId,
    now: Date.now,
  }
}

export interface CogpackImportProgress {
  done: number
  total: number
  pluginId?: string
}

export async function applyCogpackImport(
  plan: CogpackImportPlan,
  choices: CogpackImportChoices,
  options: {
    deps?: CogpackImportApplyDeps
    onProgress?: (progress: CogpackImportProgress) => void
  } = {}
): Promise<CogpackImportResult> {
  if (plan.trust.refusedBy) throw new CogpackRefusedError(plan.trust.refusedBy)
  if (choices.mode === "update" && !plan.update) {
    throw new Error("This cogpack was not imported before, so there is nothing to update")
  }
  const d = options.deps ?? (await defaultApplyDeps())
  const { manifest, fingerprint } = plan.inspected
  const installId = d.newInstallId()
  const viaCogpack: CogpackProvenance = {
    cogpackId: manifest.id,
    version: manifest.version,
    fingerprint,
  }

  const toInstall = plan.members.filter(
    (member) => member.install && choices.install.has(member.member.id)
  )
  const total = toInstall.length
  let done = 0
  options.onProgress?.({ done, total })
  const installed: string[] = []
  const failed: CogpackImportResult["failed"] = []
  const grantsToReview: CogpackImportResult["grantsToReview"] = []
  for (const member of toInstall) {
    try {
      const outcome = await member.install!({
        viaCogpack,
        ...(member.manifest?.type === "wasm"
          ? { grantDecision: d.defaultGrant(member.manifest) }
          : {}),
      })
      installed.push(member.member.id)
      if (outcome.grantToReview) grantsToReview.push(outcome.grantToReview)
    } catch (error) {
      failed.push({
        pluginId: member.member.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    done += 1
    options.onProgress?.({ done, total, pluginId: member.member.id })
  }
  if (installed.length > 0) await d.rescan()

  // Secrets go to the plugin, never into the cogset.
  for (const [pluginId, values] of Object.entries(choices.secrets)) {
    const filled = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value.length > 0)
    )
    if (Object.keys(filled).length === 0) continue
    const row = await d.getPlugin(pluginId)
    if (!row) continue
    await d.applyConfig(pluginId, { ...(row.config ?? {}), ...filled })
  }

  const failedIds = new Set(failed.map((entry) => entry.pluginId))
  const missing: CogpackImportResult["missing"] = []
  const keptVersion = new Map<string, string>()
  for (const member of plan.members) {
    const id = member.member.id
    if (member.status === "unavailable") {
      missing.push({ pluginId: id, reason: member.unavailable?.reason ?? "unavailable" })
    } else if (failedIds.has(id)) {
      missing.push({ pluginId: id, reason: "install-failed" })
    } else if (member.status === "new" && !choices.install.has(id)) {
      missing.push({ pluginId: id, reason: "skipped" })
    } else if (member.status === "different-version" && !choices.install.has(id)) {
      // The user kept their version: the cogset pins that one instead.
      keptVersion.set(id, member.installedVersion!)
    }
  }
  const withKeptVersions = (members: CogsetMember[]) =>
    members.map((member) =>
      keptVersion.has(member.pluginId)
        ? { ...member, expectedVersion: keptVersion.get(member.pluginId) }
        : member
    )

  let cogsetId: string
  const source = {
    kind: "cogpack" as const,
    cogpackId: manifest.id,
    version: manifest.version,
    fingerprint,
    installId,
  }
  if (choices.mode === "update" && plan.update) {
    cogsetId = plan.update.cogset.id
    await d.updateCogset(cogsetId, {
      members: withKeptVersions(mergeCogpackUpdate(plan.update.entries, choices.useNext)),
      source,
    })
  } else {
    const created = await d.createCogset({
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      members: withKeptVersions(manifest.members.map(cogsetMemberFromCogpack)),
      source,
    })
    cogsetId = created.id
  }

  await d.putInstall({
    id: installId,
    cogpackId: manifest.id,
    version: manifest.version,
    name: manifest.name,
    fingerprint,
    trust: plan.trust.trust,
    ...(manifest.signature
      ? { signerPublicKey: manifest.signature.publicKey, signerName: manifest.signature.publisher }
      : {}),
    manifest,
    cogsetId,
    missing,
    installedAt: d.now(),
  })
  if (choices.trustSigner && manifest.signature) await d.trustSigner(manifest.signature)

  return { installId, cogsetId, installed, failed, missing, grantsToReview }
}
