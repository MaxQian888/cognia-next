/**
 * Marketplace pre-install chain.
 *
 * Bridges between the marketplace client (`getPluginMarketplace().installPlugin`)
 * and the UI dialog hosts (`PluginPreInstallDialog`, `PluginConflictDialog`)
 * so that **no Dexie row is created until the user has approved conflicts,
 * permissions, and configuration in sequence**.
 *
 * The orchestrator is dialog-agnostic — it takes three callback functions
 * from the caller and awaits each before advancing. The marketplace card
 * (`plugin-marketplace.tsx` / `plugin-marketplace-detail.tsx`) wires those
 * callbacks to the zustand store targets the dialogs subscribe to.
 *
 * Cancellation at any step returns a `cancelled` result without calling
 * `installPlugin` — the install is fire-and-forget only AFTER the user
 * confirms every step.
 */

import type { PluginManifest, PluginPermission } from "@/types/plugin"
import { listPlugins, setPluginConfig } from "@/lib/db/plugins"
import { ConflictDetector } from "@/lib/plugin/package/conflict-detector"

// =============================================================================
// Public types
// =============================================================================

export type PreInstallStage = "conflict" | "permission" | "config" | "install"

export interface PreInstallConflict {
  /** Plugin id involved in the conflict (the install target). */
  pluginId: string
  /** Plain-text reasons surfaced to the user. Severity drives styling. */
  reasons: Array<{ severity: "high" | "medium" | "low"; message: string }>
}

export interface PreInstallPermissionPayload {
  pluginId: string
  declared: PluginPermission[]
  optional: PluginPermission[]
}

export interface PreInstallConfigPayload {
  pluginId: string
  /** Loose shape — the dialog renders whatever it can parse. */
  configSchema: Record<string, unknown>
}

export interface RunMarketplaceInstallOpts {
  pluginId: string
  version?: string

  /**
   * Resolve the conflict-review step. Invoked only when the install detects
   * conflicts (today: any already-installed plugin with the same id).
   * Return `"continue"` to advance, `"cancel"` to abort.
   */
  requestConflictReview: (conflict: PreInstallConflict) => Promise<"continue" | "cancel">

  /**
   * Resolve the permission-review step. Invoked only when the manifest
   * declares any permissions (declared or optional). Return `"approve"` to
   * advance, `"cancel"` to abort.
   */
  requestPermissionReview: (payload: PreInstallPermissionPayload) => Promise<"approve" | "cancel">

  /**
   * Resolve the configuration step. Invoked only when the manifest carries a
   * non-empty `configSchema`. Returns `"save"` with the value, or `"cancel"`.
   */
  requestConfig: (
    payload: PreInstallConfigPayload
  ) => Promise<{ result: "save"; value: unknown } | { result: "cancel" }>

  /**
   * The marketplace client. Pass the singleton from
   * `getPluginMarketplace()` — splitting out the dependency lets tests
   * inject a fake without hauling in the full client.
   */
  client: {
    getPlugin: (id: string) => Promise<{ manifest: PluginManifest; name?: string } | null>
    installPlugin: (id: string, version?: string) => Promise<unknown>
  }
}

export type RunMarketplaceInstallResult =
  | { status: "installed"; pluginId: string }
  | { status: "cancelled"; stage: PreInstallStage }
  | { status: "failed"; stage: PreInstallStage; message: string }

// =============================================================================
// Helpers
// =============================================================================

/**
 * Detect conflicts against the live plugin table. Surfaces:
 * - id collision with an already-installed plugin (severity: high)
 * - permission / command / shortcut / namespace overlaps with installed
 *   plugins, detected via `ConflictDetector` (ADR 0016 P1-6, 2026-05-17).
 *   Severity is mapped from the detector's `error`/`warning`/`info` band.
 *
 * Additional rules (signing required, incompatible dependency, etc.) can be
 * folded in here without changing the orchestrator.
 */
async function detectConflicts(
  pluginId: string,
  candidateManifest: PluginManifest | null
): Promise<PreInstallConflict | null> {
  const installed = await listPlugins()
  const reasons: PreInstallConflict["reasons"] = []

  const existing = installed.find((p) => p.id === pluginId)
  if (existing) {
    reasons.push({
      severity: "high",
      message: `alreadyInstalled:${existing.version}`,
    })
  }

  if (candidateManifest) {
    const detector = new ConflictDetector()

    // ConflictDetector reads `commands` and `shortcuts` as top-level fields on
    // PluginRegistration, not from manifest. Extract them from the manifest's
    // `commands` block where each entry has an `id` and optional `shortcut`.
    const extractRegistration = (manifest: PluginManifest) => {
      const cmdDefs = (manifest.commands ?? []) as Array<{ id?: string; shortcut?: string }>
      return {
        manifest,
        commands: cmdDefs.map((c) => c.id ?? "").filter(Boolean),
        shortcuts: cmdDefs.map((c) => c.shortcut ?? "").filter(Boolean),
      }
    }

    detector.setPlugins(
      installed
        .filter((row) => row.id !== pluginId)
        .map((row) => extractRegistration(row.manifest as unknown as PluginManifest))
    )
    detector.registerPlugin(extractRegistration(candidateManifest))
    const result = detector.detectForPlugin(pluginId)
    const severityFor = (band: "error" | "warning" | "info"): "high" | "medium" | "low" =>
      band === "error" ? "high" : band === "warning" ? "medium" : "low"
    for (const conflict of [...result.errors, ...result.warnings, ...result.info]) {
      reasons.push({
        severity: severityFor(conflict.severity),
        message: `${conflict.type}:${conflict.description}`,
      })
    }
  }

  return reasons.length > 0 ? { pluginId, reasons } : null
}

function hasConfigSchema(manifest: PluginManifest): boolean {
  const schema = (manifest as { configSchema?: unknown }).configSchema
  if (!schema || typeof schema !== "object") return false
  const obj = schema as Record<string, unknown>
  if (obj.type !== "object" || typeof obj.properties !== "object") return false
  const props = obj.properties as Record<string, unknown>
  return Object.keys(props).length > 0
}

// =============================================================================
// Orchestrator
// =============================================================================

export async function runMarketplaceInstall(
  opts: RunMarketplaceInstallOpts
): Promise<RunMarketplaceInstallResult> {
  const { pluginId, version, client } = opts

  // Step 0 — resolve the manifest. Without it we can't show permissions /
  // configSchema. Surface as a failed result rather than throwing so the
  // caller can show a toast.
  let manifest: PluginManifest
  try {
    const entry = await client.getPlugin(pluginId)
    if (!entry) {
      return { status: "failed", stage: "install", message: "plugin_not_found" }
    }
    manifest = entry.manifest
  } catch (err) {
    return {
      status: "failed",
      stage: "install",
      message: err instanceof Error ? err.message : String(err),
    }
  }

  // Step 1 — conflict review.
  const conflict = await detectConflicts(pluginId, manifest)
  if (conflict) {
    const decision = await opts.requestConflictReview(conflict)
    if (decision === "cancel") {
      return { status: "cancelled", stage: "conflict" }
    }
  }

  // Step 2 — permission review (only when there is something to review).
  const declared = manifest.permissions ?? []
  const optional = manifest.optionalPermissions ?? []
  if (declared.length > 0 || optional.length > 0) {
    const decision = await opts.requestPermissionReview({
      pluginId,
      declared,
      optional,
    })
    if (decision === "cancel") {
      return { status: "cancelled", stage: "permission" }
    }
  }

  // Step 3 — configuration (only when the manifest has parseable fields).
  // The user-provided value is persisted post-install via setPluginConfig so
  // the Dexie row reflects their edits before the plugin is enabled by the
  // manager. Empty {} payloads are skipped to avoid overriding manifest
  // defaults the manager would otherwise apply.
  let configValue: Record<string, unknown> | undefined
  if (hasConfigSchema(manifest)) {
    const schema = (manifest as { configSchema?: Record<string, unknown> }).configSchema!
    const decision = await opts.requestConfig({ pluginId, configSchema: schema })
    if (decision.result === "cancel") {
      return { status: "cancelled", stage: "config" }
    }
    if (
      decision.value !== undefined &&
      decision.value !== null &&
      typeof decision.value === "object" &&
      Object.keys(decision.value as Record<string, unknown>).length > 0
    ) {
      configValue = decision.value as Record<string, unknown>
    }
  }

  // Step 4 — actually install. Any failure here is a true install failure,
  // not a cancellation. After the install succeeds, persist the
  // configuration the user supplied in step 3 so it isn't lost. If the
  // config write fails we surface it as a failed result — the plugin row
  // exists in Dexie but the user's intent (install + configure) wasn't
  // fully met, so silent degradation is not acceptable here.
  try {
    await client.installPlugin(pluginId, version)
  } catch (err) {
    return {
      status: "failed",
      stage: "install",
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (configValue !== undefined) {
    try {
      await setPluginConfig(pluginId, configValue)
    } catch (err) {
      return {
        status: "failed",
        stage: "install",
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  return { status: "installed", pluginId }
}
