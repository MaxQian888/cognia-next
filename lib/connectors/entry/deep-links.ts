/**
 * Authorized deep links for EXTERNAL Lark surfaces (plan 2026-07-24 P3.3).
 *
 * Anything the bot publishes outside the app — menu replies, group-menu
 * links, Chat Tab URLs — must never carry a raw `conversationKey` (guessable,
 * permanent, unauthenticated). Instead:
 *
 *   - per-user links wrap a 300 s single-use entry token minted for the
 *     resolved principal, and
 *   - chat-level surfaces (Chat Tab / group menu) wrap a long-lived
 *     integrity-only surface descriptor whose AUTHORIZATION happens at
 *     resolve time (web SSO + membership check).
 *
 * Internal navigation (`/inbox/c?key=` inside the app shells) is untouched.
 * When no web entry base is configured (plain desktop installs) the builders
 * return null and callers omit the link — a raw-key URL is never the
 * fallback.
 */

import { isLarkFeatureEnabled, type LarkFlagAdapterSettings } from "../feature-flags"
import {
  issueEntryToken,
  issueSurfaceToken,
  type IssueEntryTokenInput,
  type RpcCall,
} from "./tokens"

/**
 * Layout version baked into surface URLs. Bump when `/lark/entry`'s contract
 * changes shape — the Chat Tab reconciler detects the mismatch and updates
 * every platform-side tab in place.
 */
export const CHAT_TAB_URL_VERSION = 1

export type LarkWorkbenchMode = "disabled" | "personal" | "team" | "both"

/** Entry policy only; host grants and collaboration membership remain authoritative. */
export function readWorkbenchMode(row?: LarkFlagAdapterSettings): LarkWorkbenchMode {
  const mode = row?.settings?.larkWorkbenchMode
  return mode === "personal" || mode === "team" || mode === "both" ? mode : "disabled"
}

/** Stable URL for the developer console's desktop/mobile homepage. */
export function buildWorkbenchUrl(adapterId: string, webBase: string | null): string | null {
  if (!adapterId.trim()) return null
  // Share the external-base validation, including deployment path prefixes.
  const validated = buildRunDetailsUrl("", webBase)
  if (!validated) return null
  const url = new URL(validated)
  url.pathname = url.pathname.replace(/\/agent-runs$/, "/lark/workbench")
  url.search = new URLSearchParams({ adapter_id: adapterId }).toString()
  return url.href
}

/** Web app base URL reachable from inside Lark clients, when configured. */
export function resolveWebEntryBase(adapterRow?: LarkFlagAdapterSettings): string | null {
  const configured =
    (typeof adapterRow?.settings?.webEntryBaseUrl === "string"
      ? adapterRow.settings.webEntryBaseUrl
      : undefined) ??
    process.env.COGNIA_LARK_WEB_BASE ??
    process.env.NEXT_PUBLIC_COGNIA_WEB_BASE
  const trimmed = configured?.trim().replace(/\/+$/, "")
  if (!trimmed || !/^https?:\/\//.test(trimmed)) return null
  return trimmed
}

/** External run links use the configured web client, never a relative URL or a run-supplied URL. */
export function buildRunDetailsUrl(
  runId: string,
  webBase: string | null | undefined
): string | null {
  if (!webBase) return null
  try {
    const base = new URL(webBase)
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      return null
    const url = new URL(`${base.pathname.replace(/\/+$/, "")}/agent-runs`, base.origin)
    url.searchParams.set("run", runId)
    return url.href
  } catch {
    return null
  }
}

export interface AuthorizedConversationLinkInput extends IssueEntryTokenInput {
  adapterRow?: LarkFlagAdapterSettings
}

/**
 * Personal, single-use link into one conversation. Returns null when no web
 * base is configured or web SSO is off for the adapter (resolving a personal
 * token REQUIRES an SSO session, so minting without it would only produce
 * dead links); falls back to the bare workbench URL when minting fails
 * (a broken link beats a leaking one).
 */
export async function buildAuthorizedConversationLink(
  input: AuthorizedConversationLinkInput,
  overrides: { call?: RpcCall } = {}
): Promise<string | null> {
  const base = resolveWebEntryBase(input.adapterRow)
  if (!base) return null
  if (!isLarkFeatureEnabled("larkWebSso", input.adapterRow)) return null
  try {
    const issued = await issueEntryToken(input, overrides)
    return `${base}/lark/entry?entry=${encodeURIComponent(issued.token)}`
  } catch {
    return base
  }
}

export interface SurfaceUrlInput {
  adapterRow?: LarkFlagAdapterSettings
  adapterId: string
  tenantKey: string
  appId: string
  chatId: string
  surface: "chat_tab" | "group_menu"
}

/**
 * Long-lived chat-surface URL (Chat Tab / group menu). Gated on the matching
 * feature flag so disabled installs never mint surface descriptors.
 */
export async function buildSurfaceUrl(
  input: SurfaceUrlInput,
  overrides: { call?: RpcCall } = {}
): Promise<string | null> {
  const base = resolveWebEntryBase(input.adapterRow)
  if (!base) return null
  // Chat Tab minting is flag-gated here; the group-menu service applies its
  // own gating before calling in.
  if (input.surface === "chat_tab" && !isLarkFeatureEnabled("larkChatTab", input.adapterRow)) {
    return null
  }
  const token = await issueSurfaceToken(
    {
      adapterId: input.adapterId,
      tenantKey: input.tenantKey,
      appId: input.appId,
      chatId: input.chatId,
      urlVersion: CHAT_TAB_URL_VERSION,
      surface: input.surface,
    },
    overrides
  )
  return `${base}/lark/entry?surface=${encodeURIComponent(token)}`
}
