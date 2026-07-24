/**
 * Feature flags for the Lark dual-entry / unified-identity rollout
 * (docs/plans/2026-07-24-lark-im-dual-entry-completion.md §7.2).
 *
 * Resolution order (first defined wins):
 *   1. Environment — `COGNIA_LARK_*` (works in the Node headless brain, where
 *      per-tenant operators configure the process).
 *   2. Per-adapter override — boolean (or "audit") in the non-secret
 *      `AdapterInstanceRow.settings` JSON blob, keyed by the flag name.
 *   3. localStorage (browser only) — `cognia-connector-feature-flags-v1`.
 *   4. Default.
 *
 * Defaults: every entry-surface flag is OFF (gray-release opt-in).
 * `larkStrictCallbackAuthorization` defaults to "audit" (shadow mode: all
 * authorization checks run and would-deny outcomes are audited, nothing is
 * blocked). Flipping the default to "enforce" is a deliberate post-gray
 * release step recorded in the rollout runbook — the flag exists for
 * migration and emergency downgrade to "audit", never as a long-term bypass.
 */

export type LarkBooleanFeatureFlag =
  | "larkPrincipalRegistry"
  | "larkWebSso"
  | "larkChatTab"
  | "larkNativeSlash"
  | "larkMessageShortcut"
  | "larkPlusMenu"

export type LarkStrictCallbackAuthorizationMode = "off" | "audit" | "enforce"

export const LARK_FEATURE_FLAGS_STORAGE_KEY = "cognia-connector-feature-flags-v1"

const BOOLEAN_FLAG_ENV: Record<LarkBooleanFeatureFlag, string> = {
  larkPrincipalRegistry: "COGNIA_LARK_PRINCIPAL_REGISTRY",
  larkWebSso: "COGNIA_LARK_WEB_SSO",
  larkChatTab: "COGNIA_LARK_CHAT_TAB",
  larkNativeSlash: "COGNIA_LARK_NATIVE_SLASH",
  larkMessageShortcut: "COGNIA_LARK_MESSAGE_SHORTCUT",
  larkPlusMenu: "COGNIA_LARK_PLUS_MENU",
}

const STRICT_AUTH_ENV = "COGNIA_LARK_STRICT_CALLBACK_AUTH"

const DEFAULT_BOOLEAN_FLAGS: Record<LarkBooleanFeatureFlag, boolean> = {
  larkPrincipalRegistry: false,
  larkWebSso: false,
  larkChatTab: false,
  larkNativeSlash: false,
  larkMessageShortcut: false,
  larkPlusMenu: false,
}

const DEFAULT_STRICT_AUTH_MODE: LarkStrictCallbackAuthorizationMode = "audit"

/** Structural subset of AdapterInstanceRow accepted by every helper. */
export interface LarkFlagAdapterSettings {
  settings?: Record<string, unknown>
}

function parseBooleanToken(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw
  if (typeof raw !== "string") return undefined
  const token = raw.trim().toLowerCase()
  if (token === "1" || token === "true" || token === "on") return true
  if (token === "0" || token === "false" || token === "off") return false
  return undefined
}

function parseStrictAuthToken(raw: unknown): LarkStrictCallbackAuthorizationMode | undefined {
  if (raw === true) return "enforce"
  if (raw === false) return "off"
  if (typeof raw !== "string") return undefined
  const token = raw.trim().toLowerCase()
  if (token === "audit") return "audit"
  if (token === "1" || token === "true" || token === "on" || token === "enforce") return "enforce"
  if (token === "0" || token === "false" || token === "off") return "off"
  return undefined
}

function readStoredFlags(): Record<string, unknown> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(LARK_FEATURE_FLAGS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function isLarkFeatureEnabled(
  flag: LarkBooleanFeatureFlag,
  adapterRow?: LarkFlagAdapterSettings
): boolean {
  const fromEnv = parseBooleanToken(process.env[BOOLEAN_FLAG_ENV[flag]])
  if (fromEnv !== undefined) return fromEnv
  const fromSettings = parseBooleanToken(adapterRow?.settings?.[flag])
  if (fromSettings !== undefined) return fromSettings
  const fromStorage = parseBooleanToken(readStoredFlags()[flag])
  if (fromStorage !== undefined) return fromStorage
  return DEFAULT_BOOLEAN_FLAGS[flag]
}

export function getLarkStrictCallbackAuthorizationMode(
  adapterRow?: LarkFlagAdapterSettings
): LarkStrictCallbackAuthorizationMode {
  const fromEnv = parseStrictAuthToken(process.env[STRICT_AUTH_ENV])
  if (fromEnv !== undefined) return fromEnv
  const fromSettings = parseStrictAuthToken(adapterRow?.settings?.larkStrictCallbackAuthorization)
  if (fromSettings !== undefined) return fromSettings
  const fromStorage = parseStrictAuthToken(readStoredFlags().larkStrictCallbackAuthorization)
  if (fromStorage !== undefined) return fromStorage
  return DEFAULT_STRICT_AUTH_MODE
}

export function isLarkPrincipalRegistryEnabled(adapterRow?: LarkFlagAdapterSettings): boolean {
  return isLarkFeatureEnabled("larkPrincipalRegistry", adapterRow)
}
