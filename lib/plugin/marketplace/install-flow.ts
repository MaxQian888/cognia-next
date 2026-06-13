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

import type { PluginBinaryRequirement, PluginManifest, PluginPermission } from "@/types/plugin"
import { listPlugins, getPlugin, setPluginConfig } from "@/lib/db/plugins"
import { ConflictDetector } from "@/lib/plugin/package/conflict-detector"
import { satisfiesConstraint } from "@/lib/plugin/package/dependency-resolver"
import { dispatchPluginError } from "@/lib/plugin/error-bus"

// =============================================================================
// Public types
// =============================================================================

export type PreInstallStage =
  | "conflict"
  | "dependencies"
  | "permission"
  | "binary-requirements"
  | "config"
  | "install"

/** A required plugin dependency whose installed version conflicts. */
export interface PreInstallDependencyConflict {
  /** Dependency plugin id. */
  pluginId: string
  /** Version constraint the target plugin requires. */
  required: string
  /** Version currently installed (which fails the constraint). */
  available: string
}

export interface PreInstallDependencyPayload {
  /** The install target. */
  pluginId: string
  /** Required dependency ids that are not installed at all. */
  missing: string[]
  /** Required dependencies installed at an incompatible version. */
  conflicts: PreInstallDependencyConflict[]
}

export interface PreInstallBinaryPayload {
  pluginId: string
  /** The binaries declared in `requires.binaries` that aren't satisfied. */
  missing: Array<PluginBinaryRequirement & { detectedVersion?: string }>
}

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
  /**
   * Declared network egress allowlist (`manifest.networkAccess`). Surfaced in
   * the review so the user sees WHICH hosts the plugin may reach and WHY
   * before granting `network:fetch`.
   */
  networkAccess?: {
    allowedDomains?: string[]
    reasoning?: string
  }
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
   * Resolve the dependency-review step. Invoked only when the manifest
   * declares `dependencies` AND at least one required dependency is missing
   * or installed at an incompatible version. Return `"continue"` to advance
   * (the user will install the dependency separately) or `"cancel"` to abort.
   * Optional — when absent, an unmet required dependency aborts the install
   * with a `cancelled/dependencies` result (the plugin can't function without
   * it, so silently proceeding is not acceptable).
   */
  requestDependencyReview?: (payload: PreInstallDependencyPayload) => Promise<"continue" | "cancel">

  /**
   * Look up an installed plugin's version by id. Injected so tests don't need
   * a live Dexie; defaults to `getPlugin` from `@/lib/db/plugins`.
   */
  checkInstalledPlugin?: (id: string) => Promise<{ version: string } | null>

  /**
   * Resolve the permission-review step. Invoked only when the manifest
   * declares any permissions (declared or optional). Return `"approve"` to
   * advance, `"cancel"` to abort.
   */
  requestPermissionReview: (payload: PreInstallPermissionPayload) => Promise<"approve" | "cancel">

  /**
   * Resolve the binary-requirements step. Invoked only when the manifest
   * declares `requires.binaries` AND at least one is missing / below its
   * minVersion. The dialog may re-probe internally ("I installed it");
   * it resolves `"proceed"` when the user wants to continue (all satisfied
   * or override) or `"cancel"` to abort. Optional — when absent, a missing
   * binary aborts the install with a `cancelled/binary-requirements` result.
   */
  requestBinaryReview?: (payload: PreInstallBinaryPayload) => Promise<"proceed" | "cancel">

  /**
   * Probe a single binary's presence + version. Injected so tests don't
   * shell out; defaults to the real `detectCli` from `lib/cli-bridge`.
   */
  detectBinary?: (name: string) => Promise<{ available: boolean; version: string | null }>

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

  /**
   * Rollback hook for failures that happen AFTER `client.installPlugin`
   * returns successfully — currently only the `setPluginConfig` step.
   * The default implementation lazy-loads `getPluginManager()` and calls
   * `rollbackInstallation` on it. Tests inject a spy to assert the call
   * without dragging the full manager into the unit setup.
   *
   * `null` means "skip rollback" (used in tests that simulate the
   * config-persist failure without exercising the manager). In
   * production callers should leave this undefined so the default fires.
   */
  rollback?: ((pluginId: string, reason: string) => Promise<void>) | null
}

/**
 * Discriminant for `failed` results. `install-rollback` is only emitted
 * when the post-install rollback itself failed — the plugin row may
 * still be in Dexie and the user must uninstall manually. The UI uses
 * the distinction to escalate the toast severity.
 */
export type RunMarketplaceFailedStage = PreInstallStage | "install-rollback"

export type RunMarketplaceInstallResult =
  | { status: "installed"; pluginId: string }
  | { status: "cancelled"; stage: PreInstallStage }
  | { status: "failed"; stage: RunMarketplaceFailedStage; message: string }

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

/**
 * Probe the manifest's `requires.binaries` and return the subset that
 * isn't satisfied (absent, or present but below `minVersion`). Returns an
 * empty array when the manifest declares no binaries or all are present.
 *
 * `detectBinary` is injected by the orchestrator (defaulting to the real
 * `detectCli`) so this stays unit-testable without spawning processes.
 */
async function resolveMissingBinaries(
  manifest: PluginManifest,
  detectBinary: (name: string) => Promise<{ available: boolean; version: string | null }>
): Promise<PreInstallBinaryPayload["missing"]> {
  const required = manifest.requires?.binaries ?? []
  if (required.length === 0) return []
  const { satisfiesMinVersion } = await import("@/lib/cli-bridge/detect-cli")
  const missing: PreInstallBinaryPayload["missing"] = []
  for (const req of required) {
    const probe = await detectBinary(req.name)
    const ok = probe.available && satisfiesMinVersion(probe.version, req.minVersion)
    if (!ok) {
      missing.push({ ...req, detectedVersion: probe.version ?? undefined })
    }
  }
  return missing
}

/** Default binary probe — lazy-loads the real detector. */
async function defaultDetectBinary(
  name: string
): Promise<{ available: boolean; version: string | null }> {
  try {
    const { detectCli } = await import("@/lib/cli-bridge/detect-cli")
    const r = await detectCli(name)
    return { available: r.available, version: r.version }
  } catch {
    // If the detector can't load (web bundle without the command), treat
    // as "not available" — the gate then surfaces the requirement.
    return { available: false, version: null }
  }
}

/**
 * Resolve the manifest's required `dependencies` against installed plugins.
 * Returns the missing ids + version conflicts. `optionalDependencies` are
 * intentionally NOT gated — they degrade gracefully by design.
 *
 * `checkInstalled` is injected (defaulting to `getPlugin`) so this stays
 * unit-testable without a live Dexie.
 */
async function resolveDependencyIssues(
  pluginId: string,
  manifest: PluginManifest,
  checkInstalled: (id: string) => Promise<{ version: string } | null>
): Promise<PreInstallDependencyPayload> {
  const required = manifest.dependencies ?? {}
  const missing: string[] = []
  const conflicts: PreInstallDependencyConflict[] = []
  for (const [depId, constraint] of Object.entries(required)) {
    const installed = await checkInstalled(depId)
    if (!installed) {
      missing.push(depId)
    } else if (!satisfiesConstraint(installed.version, constraint)) {
      conflicts.push({ pluginId: depId, required: constraint, available: installed.version })
    }
  }
  return { pluginId, missing, conflicts }
}

/** Default installed-plugin probe — reads the Dexie plugin row. */
async function defaultCheckInstalledPlugin(id: string): Promise<{ version: string } | null> {
  const row = await getPlugin(id)
  return row ? { version: row.version } : null
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

  // Step 1.5 — dependency review (only when the manifest declares required
  // `dependencies` AND at least one is missing / version-incompatible). Like
  // the binary step: absent review callback blocks the install, since the
  // plugin can't function without its dependencies.
  const depIssues = await resolveDependencyIssues(
    pluginId,
    manifest,
    opts.checkInstalledPlugin ?? defaultCheckInstalledPlugin
  )
  if (depIssues.missing.length > 0 || depIssues.conflicts.length > 0) {
    if (!opts.requestDependencyReview) {
      return { status: "cancelled", stage: "dependencies" }
    }
    const decision = await opts.requestDependencyReview(depIssues)
    if (decision === "cancel") {
      return { status: "cancelled", stage: "dependencies" }
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
      networkAccess: manifest.networkAccess,
    })
    if (decision === "cancel") {
      return { status: "cancelled", stage: "permission" }
    }
  }

  // Step 2.5 — binary requirements (only when the manifest declares any
  // and at least one is missing). The detector is injectable; the UI
  // dialog may re-probe internally before resolving.
  const missingBinaries = await resolveMissingBinaries(
    manifest,
    opts.detectBinary ?? defaultDetectBinary
  )
  if (missingBinaries.length > 0) {
    if (!opts.requestBinaryReview) {
      // No UI to resolve the requirement → block the install.
      return { status: "cancelled", stage: "binary-requirements" }
    }
    const decision = await opts.requestBinaryReview({ pluginId, missing: missingBinaries })
    if (decision === "cancel") {
      return { status: "cancelled", stage: "binary-requirements" }
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
      const reason = err instanceof Error ? err.message : String(err)
      // The manager finished a successful install — the user's intent
      // (install + configure) didn't fully complete, so leaving the row
      // in place would surface the plugin as "installed" with stale
      // config. Roll back to pre-install state so the user can retry
      // with their config still in mind.
      const rollbackFn =
        opts.rollback === undefined ? await resolveDefaultRollback() : opts.rollback
      if (rollbackFn) {
        try {
          await rollbackFn(pluginId, `Config persistence failed: ${reason}`)
        } catch (rollbackErr) {
          const rollbackReason =
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
          dispatchPluginError({
            pluginId,
            stage: "install-rollback",
            message: rollbackReason,
            severity: "error",
            recoverable: false,
          })
          return {
            status: "failed",
            stage: "install-rollback",
            message: rollbackReason,
          }
        }
      }
      return {
        status: "failed",
        stage: "install",
        message: reason,
      }
    }
  }

  return { status: "installed", pluginId }
}

/**
 * Lazy-load the production rollback hook
 * (`getPluginManager().rollbackInstallation`). Dynamic import so the
 * install-flow module stays cheap to load in headless tests that never
 * reach the post-install branch, and so the marketplace ⇄ manager edge
 * stays one-directional at module-graph time.
 *
 * Returns `null` when the manager isn't initialized (which happens in
 * tests that exercise install-flow in isolation) so the caller can
 * fall through without crashing — the post-install row is left in
 * Dexie and the test runner is expected to assert on the result.
 */
async function resolveDefaultRollback(): Promise<
  ((pluginId: string, reason: string) => Promise<void>) | null
> {
  try {
    const mod = await import("@/lib/plugin/core/manager")
    // Probe `getPluginManager()` synchronously — when the host hasn't
    // bootstrapped the singleton yet (tests, very early app startup)
    // it throws, and we fall back to "no rollback hook" rather than
    // letting the install-flow surface a misleading
    // "install-rollback failed" result to the user.
    try {
      mod.getPluginManager()
    } catch {
      return null
    }
    return (pluginId, reason) => mod.getPluginManager().rollbackInstallation(pluginId, reason)
  } catch {
    return null
  }
}
