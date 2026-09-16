/**
 * The action catalog as the user edits it (ADR-0188 D17, B3).
 *
 * The built-in actions are fixed code; what the user owns is a set of
 * overrides on them and a list of actions of their own. Everything that reads
 * the catalog — the chat router, the Run API, the settings editor — goes
 * through `listFusionActions` and `actionExtensionFor`, so what the editor
 * shows is exactly what a run pins.
 *
 * Every edit changes the action's hash: the hash covers the roles, the
 * verifier profile, the prompt version and the whole extension (caps, limits,
 * web tools), plus the deployments behind each alias when a run compiles it.
 * A run keeps the hash it was routed under, so an edit never rewrites what an
 * earlier run did.
 *
 * A saved catalog must always compile: an invalid custom action would make
 * every route fail, not just its own. `validateActionDraft` is the rule, the
 * editor refuses to save what it rejects, and settings normalization drops
 * anything persisted that it rejects.
 */

import { BUILTIN_ACTIONS, defaultExtension } from "../config/builtin-catalog"
import {
  OPTIONAL_ROLES,
  REQUIRED_ROLES,
  type ActionExtension,
  type ActionLimits,
  type VerifierProfile,
} from "../config/types"
import type { ActionConfig, ExecutionMode } from "../contracts/schemas"
import { MoneyError, usdToMicrousd } from "../money/microusd"
import { canonicalHash } from "../util/sha256"
import type { ActionOverride, RouterFusionSettings } from "./settings"

/** A custom action's id: lowercase, starts with a letter, 3–48 characters. */
export const CUSTOM_ACTION_ID_PATTERN = /^[a-z][a-z0-9_]{2,47}$/

/**
 * Modes an action of the user's own may have. Delegate is DORMANT until B4 (a
 * workspace, a sandbox and an approval step): the editor shows it disabled and
 * labelled, and validation refuses it.
 */
export const EDITABLE_ACTION_MODES: readonly ExecutionMode[] = ["direct", "cascade", "panel"]

/**
 * The verifier profiles an edited action may pick, per mode. `code_fixture` is
 * DORMANT until B4 supplies a runtime verifier: without one it can only ever be
 * inconclusive, so it is not offered; the built-in `cascade_code` keeps it and
 * the router excludes it until then.
 */
export const EDITABLE_PROFILES_BY_MODE: Record<ExecutionMode, readonly VerifierProfile[]> = {
  direct: ["text_basic", "text_review", "schema_fixture"],
  cascade: ["text_basic", "text_review", "schema_fixture"],
  panel: ["evidence_review"],
  delegate: [],
}

export type ActionDraftIssue =
  | { field: "id"; code: "ID_INVALID" | "ID_TAKEN" }
  | { field: "mode"; code: "MODE_NOT_EDITABLE" }
  | { field: "roles"; code: "ROLE_MISSING" | "ROLE_UNKNOWN" | "ALIAS_EMPTY"; role: string }
  | { field: "verifier_profile"; code: "PROFILE_NOT_ALLOWED" }
  | { field: "runCapUsd"; code: "CAP_INVALID" }
  | { field: "panel_size"; code: "PANEL_C_REQUIRED" | "LIMIT_INVALID" }

export function isBuiltinActionId(id: string): boolean {
  return BUILTIN_ACTIONS.some((action) => action.id === id)
}

export function builtinAction(id: string): ActionConfig | undefined {
  return BUILTIN_ACTIONS.find((action) => action.id === id)
}

/** The roles an action of this mode may name, required first. */
export function rolesOf(mode: ExecutionMode): {
  required: readonly string[]
  optional: readonly string[]
} {
  return { required: REQUIRED_ROLES[mode], optional: OPTIONAL_ROLES[mode] }
}

/** A new action of `mode`, seeded from the built-in action of that mode. */
export function draftActionFor(mode: ExecutionMode, id = ""): ActionConfig {
  const template = BUILTIN_ACTIONS.find((action) => action.mode === mode)
  const profile = EDITABLE_PROFILES_BY_MODE[mode][0] ?? template?.verifier_profile ?? "text_basic"
  return {
    id,
    mode,
    roles: { ...(template?.roles ?? {}) },
    prompt_version: template?.prompt_version ?? "roles-1",
    verifier_profile: profile,
    enabled: true,
  }
}

function isUsd(value: string): boolean {
  try {
    usdToMicrousd(value)
    return true
  } catch (error) {
    if (error instanceof MoneyError) return false
    throw error
  }
}

/**
 * What stops an action of the user's own from being saved. `takenIds` are the
 * other custom actions' ids; the built-in ids are always taken. An alias that
 * no mapping defines is not an issue here: the router omits such an action
 * with a reason, and the mapping may be added later.
 */
export function validateActionDraft(
  action: ActionConfig,
  takenIds: readonly string[]
): ActionDraftIssue[] {
  const issues: ActionDraftIssue[] = []
  if (!CUSTOM_ACTION_ID_PATTERN.test(action.id)) issues.push({ field: "id", code: "ID_INVALID" })
  else if (isBuiltinActionId(action.id) || takenIds.includes(action.id)) {
    issues.push({ field: "id", code: "ID_TAKEN" })
  }
  if (!EDITABLE_ACTION_MODES.includes(action.mode)) {
    issues.push({ field: "mode", code: "MODE_NOT_EDITABLE" })
    return issues
  }
  issues.push(...roleIssues(action.mode, action.roles))
  if (
    !EDITABLE_PROFILES_BY_MODE[action.mode].includes(action.verifier_profile as VerifierProfile)
  ) {
    issues.push({ field: "verifier_profile", code: "PROFILE_NOT_ALLOWED" })
  }
  return issues
}

function roleIssues(mode: ExecutionMode, roles: Record<string, string>): ActionDraftIssue[] {
  const issues: ActionDraftIssue[] = []
  const { required, optional } = rolesOf(mode)
  for (const role of required) {
    if (!(role in roles)) issues.push({ field: "roles", code: "ROLE_MISSING", role })
  }
  for (const [role, alias] of Object.entries(roles)) {
    if (!required.includes(role) && !optional.includes(role)) {
      issues.push({ field: "roles", code: "ROLE_UNKNOWN", role })
    } else if (typeof alias !== "string" || alias.trim().length === 0) {
      issues.push({ field: "roles", code: "ALIAS_EMPTY", role })
    }
  }
  return issues
}

/**
 * What stops an override of any action from being saved: the roles it would
 * leave the action with, the profile, the cap and the panel size.
 */
export function validateOverride(
  action: ActionConfig,
  override: ActionOverride
): ActionDraftIssue[] {
  const issues: ActionDraftIssue[] = []
  const roles = { ...action.roles, ...(override.roles ?? {}) }
  issues.push(...roleIssues(action.mode, roles))
  if (
    override.verifier_profile !== undefined &&
    override.verifier_profile !== action.verifier_profile &&
    !EDITABLE_PROFILES_BY_MODE[action.mode].includes(override.verifier_profile as VerifierProfile)
  ) {
    issues.push({ field: "verifier_profile", code: "PROFILE_NOT_ALLOWED" })
  }
  if (override.runCapUsd !== undefined && !isUsd(override.runCapUsd)) {
    issues.push({ field: "runCapUsd", code: "CAP_INVALID" })
  }
  const panelSize = override.limits?.panel_size
  if (panelSize !== undefined) {
    if (action.mode !== "panel" || (panelSize !== 2 && panelSize !== 3)) {
      issues.push({ field: "panel_size", code: "LIMIT_INVALID" })
    } else if (panelSize === 3 && !("panel_c" in roles)) {
      issues.push({ field: "panel_size", code: "PANEL_C_REQUIRED" })
    }
  }
  return issues
}

/** An action with the user's override applied. */
export function applyActionOverride(
  action: ActionConfig,
  override: ActionOverride | undefined
): ActionConfig {
  if (!override) return { ...action, roles: { ...action.roles } }
  return {
    ...action,
    roles: { ...action.roles, ...(override.roles ?? {}) },
    ...(override.verifier_profile ? { verifier_profile: override.verifier_profile } : {}),
    ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
  }
}

/** The built-in catalog with the user's overrides applied, followed by the user's own actions. */
export function listFusionActions(settings: RouterFusionSettings): ActionConfig[] {
  return [
    ...BUILTIN_ACTIONS.map((action) =>
      applyActionOverride(action, settings.actionOverrides[action.id])
    ),
    ...settings.customActions.map((action) =>
      applyActionOverride(action, settings.actionOverrides[action.id])
    ),
  ]
}

/** The run-time extension of an action: mode defaults, the mode cap, then the action's own override. */
export function actionExtensionFor(
  action: ActionConfig,
  settings: RouterFusionSettings
): ActionExtension {
  const base = defaultExtension(action.mode)
  const override = settings.actionOverrides[action.id]
  const capUsd = override?.runCapUsd ?? settings.runCapUsdByMode[action.mode]
  let runCap = base.run_cap_microusd
  if (capUsd !== undefined && isUsd(capUsd)) runCap = usdToMicrousd(capUsd)
  return {
    ...base,
    limits: { ...base.limits, ...(override?.limits ?? {}) },
    run_cap_microusd: runCap,
    web_tools_enabled: override?.webToolsEnabled ?? base.web_tools_enabled,
  }
}

/**
 * The hash of what the user configured for an action. A run's `action_hash`
 * covers this and, in addition, the deployments each alias resolved to, so two
 * runs of an unchanged action differ only when a mapping changed underneath.
 */
export function actionConfigHash(action: ActionConfig, extension: ActionExtension): string {
  return canonicalHash({
    id: action.id,
    mode: action.mode,
    roles: action.roles,
    prompt_version: action.prompt_version,
    verifier_profile: action.verifier_profile,
    extension,
  })
}

function sameRecord(a: Record<string, unknown> | undefined, b: Record<string, unknown>): boolean {
  return canonicalHash(a ?? {}) === canonicalHash(b)
}

/**
 * The overrides after one edit of an action. Fields that equal what the action
 * already has without an override are dropped, and an override with nothing
 * left in it is removed, so "back to the built-in" leaves no trace.
 */
export function withActionOverride(
  settings: RouterFusionSettings,
  actionId: string,
  patch: ActionOverride
): Record<string, ActionOverride> {
  const base =
    builtinAction(actionId) ?? settings.customActions.find((action) => action.id === actionId)
  const overrides = { ...settings.actionOverrides }
  if (!base) return overrides
  const merged: ActionOverride = { ...(overrides[actionId] ?? {}), ...patch }
  const next: ActionOverride = {}
  if (merged.enabled !== undefined && merged.enabled !== base.enabled) next.enabled = merged.enabled
  if (merged.roles) {
    const roles = Object.fromEntries(
      Object.entries(merged.roles).filter(([role, alias]) => base.roles[role] !== alias)
    )
    if (Object.keys(roles).length > 0) next.roles = roles
  }
  if (merged.verifier_profile !== undefined && merged.verifier_profile !== base.verifier_profile) {
    next.verifier_profile = merged.verifier_profile
  }
  if (merged.runCapUsd !== undefined && merged.runCapUsd !== settings.runCapUsdByMode[base.mode]) {
    next.runCapUsd = merged.runCapUsd
  }
  const defaults = defaultExtension(base.mode)
  if (
    merged.webToolsEnabled !== undefined &&
    merged.webToolsEnabled !== defaults.web_tools_enabled
  ) {
    next.webToolsEnabled = merged.webToolsEnabled
  }
  if (merged.limits) {
    const limits = Object.fromEntries(
      Object.entries(merged.limits).filter(
        ([key, value]) =>
          value !== undefined && defaults.limits[key as keyof ActionLimits] !== value
      )
    ) as Partial<ActionLimits>
    if (!sameRecord(limits, {})) next.limits = limits
  }
  if (Object.keys(next).length === 0) delete overrides[actionId]
  else overrides[actionId] = next
  return overrides
}

/** The overrides with an action's override gone. */
export function withoutActionOverride(
  settings: RouterFusionSettings,
  actionId: string
): Record<string, ActionOverride> {
  const overrides = { ...settings.actionOverrides }
  delete overrides[actionId]
  return overrides
}

/** Add or replace an action of the user's own. The caller validated it. */
export function withCustomAction(
  settings: RouterFusionSettings,
  action: ActionConfig
): ActionConfig[] {
  const copy = { ...action, roles: { ...action.roles } }
  const index = settings.customActions.findIndex((existing) => existing.id === action.id)
  if (index === -1) return [...settings.customActions, copy]
  return settings.customActions.map((existing, i) => (i === index ? copy : existing))
}

/** Remove an action of the user's own, with any override on it. */
export function withoutCustomAction(
  settings: RouterFusionSettings,
  actionId: string
): Pick<RouterFusionSettings, "customActions" | "actionOverrides"> {
  return {
    customActions: settings.customActions.filter((action) => action.id !== actionId),
    actionOverrides: withoutActionOverride(settings, actionId),
  }
}

const OVERRIDE_LIMIT_KEYS = new Set<keyof ActionLimits>(
  Object.keys(defaultExtension("panel").limits) as Array<keyof ActionLimits>
)

/**
 * A persisted override, kept only as far as it is well-formed. Anything else a
 * newer or older build wrote is dropped rather than trusted.
 */
export function sanitizeActionOverride(raw: unknown): ActionOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: ActionOverride = {}
  if (typeof r.enabled === "boolean") out.enabled = r.enabled
  if (r.roles && typeof r.roles === "object" && !Array.isArray(r.roles)) {
    const roles = Object.fromEntries(
      Object.entries(r.roles as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].trim().length > 0
      )
    )
    if (Object.keys(roles).length > 0) out.roles = roles
  }
  if (typeof r.verifier_profile === "string") out.verifier_profile = r.verifier_profile
  if (typeof r.runCapUsd === "string" && isUsd(r.runCapUsd)) out.runCapUsd = r.runCapUsd
  if (typeof r.webToolsEnabled === "boolean") out.webToolsEnabled = r.webToolsEnabled
  if (r.limits && typeof r.limits === "object" && !Array.isArray(r.limits)) {
    const limits: Partial<ActionLimits> = {}
    for (const [key, value] of Object.entries(r.limits as Record<string, unknown>)) {
      if (
        OVERRIDE_LIMIT_KEYS.has(key as keyof ActionLimits) &&
        Number.isSafeInteger(value) &&
        (value as number) >= 0
      ) {
        ;(limits as Record<string, number>)[key] = value as number
      }
    }
    if (Object.keys(limits).length > 0) out.limits = limits
  }
  return Object.keys(out).length > 0 ? out : null
}

/** A persisted custom action, kept only when it would compile. */
export function sanitizeCustomAction(
  raw: unknown,
  takenIds: readonly string[]
): ActionConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (
    typeof r.id !== "string" ||
    typeof r.mode !== "string" ||
    typeof r.prompt_version !== "string" ||
    typeof r.verifier_profile !== "string" ||
    typeof r.enabled !== "boolean" ||
    !r.roles ||
    typeof r.roles !== "object" ||
    Array.isArray(r.roles)
  ) {
    return null
  }
  const roles: Record<string, string> = {}
  for (const [role, alias] of Object.entries(r.roles as Record<string, unknown>)) {
    if (typeof alias !== "string") return null
    roles[role] = alias
  }
  const action: ActionConfig = {
    id: r.id,
    mode: r.mode as ExecutionMode,
    roles,
    prompt_version: r.prompt_version,
    verifier_profile: r.verifier_profile,
    enabled: r.enabled,
  }
  return validateActionDraft(action, takenIds).length === 0 ? action : null
}
