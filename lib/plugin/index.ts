/**
 * Plugin runtime entry point.
 *
 * Phase 2 activation (Task #15): the no-op stubs are replaced with delegations
 * to the real `HookDispatcher` and the lifecycle / event hook classes ported
 * verbatim from Cognia under `lib/plugin/messaging/hooks-system.ts`. The
 * existing public interfaces (`PluginEventHooks`, `PluginLifecycleHooks`) are
 * kept unchanged so live call sites in `lib/scheduler/task-scheduler.ts`,
 * `lib/ai/embedding/compression.ts`, and the external-agent manager wake up
 * automatically — no edits needed there.
 *
 * Method-signature compatibility: every method name + arity referenced by
 * existing call sites matches the Cognia class verbatim
 * (`dispatchOnScheduledTaskStart`, `dispatchOnScheduledTaskComplete`,
 * `dispatchOnScheduledTaskError`, `dispatchPreCompact`, plus the
 * external-agent + artifact lifecycle dispatchers). The structural typing is
 * preserved so this swap is type-safe; we cast at the boundary because the
 * Cognia classes carry richer methods than this contract advertises.
 */

import {
  getPluginEventHooks as getRealPluginEventHooks,
  getPluginLifecycleHooks as getRealPluginLifecycleHooks,
} from "./messaging/hooks-system"

export interface PluginInfo {
  id: string
  name: string
  version?: string
}

interface PluginManager {
  list(): PluginInfo[]
  get(id: string): PluginInfo | undefined
}

/**
 * Plugin manager facade. Replaced with the full PluginManager from
 * `lib/plugin/core/manager.ts` once the core port (Task #13) lands. Until
 * then, this remains a defensive stub so call sites that probe
 * `pluginManager.list()` get an empty list instead of crashing.
 */
export const pluginManager: PluginManager = {
  list: () => [],
  get: () => undefined,
}

/**
 * Plugin event hook dispatchers. The contract mirrors Cognia's class — see
 * `lib/plugin/messaging/hooks-system.ts:PluginEventHooks` for the full
 * surface (richer than this interface; the extra methods are forward-compat
 * for plugin authors but unused by current cognia-next call sites).
 */
export interface PluginEventHooks {
  beforeSend?: Array<(payload: unknown) => unknown>
  afterReceive?: Array<(payload: unknown) => unknown>
  onError?: Array<(error: unknown) => void>
  dispatchExternalAgentConnect: (...args: unknown[]) => void
  dispatchExternalAgentDisconnect: (...args: unknown[]) => void
  dispatchExternalAgentError: (...args: unknown[]) => void
  dispatchExternalAgentExecutionStart: (...args: unknown[]) => void
  dispatchExternalAgentExecutionComplete: (...args: unknown[]) => void
  dispatchArtifactCreate: (...args: unknown[]) => void
  dispatchArtifactUpdate: (...args: unknown[]) => void
  dispatchArtifactDelete: (...args: unknown[]) => void
  dispatchArtifactOpen: (...args: unknown[]) => void
  dispatchArtifactClose: (...args: unknown[]) => void
  dispatchPreCompact: (
    payload: unknown
  ) => Promise<{ handled?: boolean; summary?: string; metadata?: Record<string, unknown> } | null>
}

/**
 * Returns the real `PluginEventHooks` singleton. Until any plugin registers
 * a hook, every dispatcher iterates an empty list and returns synchronously
 * — preserving the existing no-op semantics so activation is risk-free.
 */
export function getPluginEventHooks(): PluginEventHooks {
  // The Cognia class is a strict superset of our local interface — same
  // method names, arities, and return shapes, with extra methods for hook
  // categories cognia-next doesn't dispatch yet.
  return getRealPluginEventHooks() as unknown as PluginEventHooks
}

/**
 * Plugin lifecycle hook dispatchers — identical activation pattern as
 * `getPluginEventHooks()`. The scheduler at `lib/scheduler/task-scheduler.ts`
 * calls these on every task start / complete / error event; before
 * activation the calls were no-ops, after activation they fan out to every
 * registered plugin's `onScheduledTask*` hook.
 */
export interface PluginLifecycleHooks {
  dispatchOnScheduledTaskStart: (taskId: string, executionId: string) => void
  dispatchOnScheduledTaskComplete: (
    taskId: string,
    executionId: string,
    result: { success: boolean; output?: unknown }
  ) => void
  dispatchOnScheduledTaskError: (taskId: string, executionId: string, error: Error) => void
}

export function getPluginLifecycleHooks(): PluginLifecycleHooks {
  return getRealPluginLifecycleHooks() as unknown as PluginLifecycleHooks
}

// =============================================================================
// Manifest validation
// =============================================================================

import type { PluginManifest } from "@/types/plugin"

export interface ValidationDiagnostic {
  code: string
  message: string
  severity: "error" | "warning"
  field?: string
}

export interface ManifestValidationResult {
  valid: boolean
  diagnostics: ValidationDiagnostic[]
}

const REQUIRED_FIELDS: Array<keyof PluginManifest> = ["id", "name", "version", "type"]

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const ID_PATTERN = /^[a-z0-9][a-z0-9-_]*(?:\.[a-z0-9][a-z0-9-_]*)*$/

/**
 * Validate a plugin manifest. Returns a diagnostics array; the manifest
 * is considered valid only if every diagnostic has severity `warning`.
 *
 * The validator is conservative — it checks the fields that the runtime
 * actually relies on (id / version / capabilities) and surfaces the
 * rest as warnings so plugin authors can iterate. Strict capability
 * checks live in `lib/plugin/contracts/plugin-capabilities.ts`.
 */
export function validatePluginManifest(manifest: unknown): ManifestValidationResult {
  const diagnostics: ValidationDiagnostic[] = []

  if (!manifest || typeof manifest !== "object") {
    diagnostics.push({
      code: "manifest.not-object",
      severity: "error",
      message: "Plugin manifest must be a JSON object.",
    })
    return { valid: false, diagnostics }
  }

  const m = manifest as Partial<PluginManifest>

  for (const field of REQUIRED_FIELDS) {
    if (m[field] === undefined || m[field] === null || m[field] === "") {
      diagnostics.push({
        code: "manifest.required-field-missing",
        severity: "error",
        field: String(field),
        message: `Required field "${String(field)}" is missing.`,
      })
    }
  }

  if (typeof m.id === "string" && !ID_PATTERN.test(m.id)) {
    diagnostics.push({
      code: "manifest.id-format",
      severity: "error",
      field: "id",
      message: `Plugin id "${m.id}" must match ${ID_PATTERN.source}.`,
    })
  }

  if (typeof m.version === "string" && !SEMVER.test(m.version)) {
    diagnostics.push({
      code: "manifest.version-format",
      severity: "error",
      field: "version",
      message: `Plugin version "${m.version}" is not a valid semver string.`,
    })
  }

  if (m.capabilities !== undefined && !Array.isArray(m.capabilities)) {
    diagnostics.push({
      code: "manifest.capabilities-type",
      severity: "error",
      field: "capabilities",
      message: "`capabilities` must be an array of strings.",
    })
  }

  if (m.activationEvents !== undefined && !Array.isArray(m.activationEvents)) {
    diagnostics.push({
      code: "manifest.activationEvents-type",
      severity: "error",
      field: "activationEvents",
      message: "`activationEvents` must be an array of strings.",
    })
  }

  const valid = diagnostics.every((d) => d.severity !== "error")
  return { valid, diagnostics }
}
