/**
 * Adapter factory registry — Task 41 + Task 68 + Task 80 + Task 93 + Task 107.
 *
 * Switch on AdapterInstanceRow.type to instantiate the correct PlatformAdapter.
 * Phase 1 ships Telegram, Discord, Slack, Lark, and OneBot.
 *
 * NOTE: OneBot does NOT use OAuth. It uses a reverse-WebSocket transport — the
 * QQ client connects to cognia-next, not the other way around. No OAuth flow is
 * needed; the only optional credential is the bearer token stored in the keyring
 * under `<adapterId>:onebotBearer`.
 */

import type { PlatformAdapter } from "@/types/connectors"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { createTelegramAdapter } from "./adapters/telegram"
import { createDiscordAdapter } from "./adapters/discord"
import { createSlackAdapter } from "./adapters/slack"
import { createLarkAdapter } from "./adapters/lark"
import { createOneBotAdapter } from "./adapters/onebot"
import { createWeComAdapter } from "./adapters/wecom"
import type { WeComAdapterSettings } from "./adapters/wecom/welcome"
import { createWechatPersonalAdapter } from "./adapters/wechat-personal"
import { getTenantAccessToken } from "./adapters/lark/auth"

/**
 * Build and return a PlatformAdapter for the given row.
 *
 * Returns null for unsupported adapter types (logs a warning).
 */
export async function buildAdapterFromRow(
  row: AdapterInstanceRow
): Promise<PlatformAdapter | null> {
  switch (row.type) {
    case "telegram":
      return buildTelegramAdapter(row)
    case "discord":
      return buildDiscordAdapter(row)
    case "slack":
      return buildSlackAdapter(row)
    case "lark":
      return buildLarkAdapter(row)
    case "onebot":
      return buildOneBotAdapter(row)
    case "wecom":
      return buildWeComAdapter(row)
    case "wechat-personal":
      return buildWechatPersonalAdapter(row)
    default:
      // Unsupported platform in Phase 1 — skip silently.
      console.warn(`[adapter-registry] unsupported adapter type: ${row.type} (id=${row.id})`)
      return null
  }
}

/**
 * Instantiate a Telegram PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Reads the bot token from the keyring and calls getMe to fetch the bot's
 * own user id (selfId), then delegates to createTelegramAdapter.
 */
export async function buildTelegramAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const transport = row.transportMode === "webhook" ? "webhook" : "longpoll"

  // Resolve selfId by calling getMe via the Tauri HTTP proxy
  const tokenRaw = await connectorsKeyringGet(row.id, "botToken")
  const token = tokenRaw ?? ""

  let selfId = ""
  try {
    const resp = await connectorsHttpRequest({
      url: `https://api.telegram.org/bot${token}/getMe`,
      method: "GET",
    })
    const parsed = JSON.parse(resp.body) as { ok: boolean; result?: { id?: number } }
    if (parsed.ok && parsed.result?.id !== undefined) {
      selfId = String(parsed.result.id)
    }
  } catch {
    // Non-fatal: selfId will be empty string; adapter still starts but may
    // not correctly detect self-mentions.
    console.warn(`[adapter-registry] getMe failed for adapter ${row.id}`)
  }

  return createTelegramAdapter({
    id: row.id,
    displayName: row.displayName,
    transport,
    botToken: () => connectorsKeyringGet(row.id, "botToken").then((t) => t ?? ""),
    selfId,
  })
}

/**
 * Instantiate a Discord PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Reads the bot token from the keyring and calls /users/@me to fetch the
 * bot's own user id (selfId), then delegates to createDiscordAdapter.
 */
export async function buildDiscordAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const tokenRaw = await connectorsKeyringGet(row.id, "botToken")
  const token = tokenRaw ?? ""

  let selfId = ""
  try {
    const resp = await connectorsHttpRequest({
      url: "https://discord.com/api/v10/users/@me",
      method: "GET",
      headers: { Authorization: `Bot ${token}` },
    })
    const parsed = JSON.parse(resp.body) as { id?: string }
    if (parsed.id) {
      selfId = parsed.id
    }
  } catch {
    // Non-fatal: selfId will be empty string; adapter refreshes from READY event.
    console.warn(`[adapter-registry] /users/@me failed for Discord adapter ${row.id}`)
  }

  return createDiscordAdapter({
    id: row.id,
    displayName: row.displayName,
    botToken: () => connectorsKeyringGet(row.id, "botToken").then((t) => t ?? ""),
    selfId,
  })
}

/**
 * Instantiate a Slack PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Reads the bot token from the keyring and calls auth.test to fetch the
 * bot's own user id (selfId), then delegates to createSlackAdapter.
 */
export async function buildSlackAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const tokenRaw = await connectorsKeyringGet(row.id, "botToken")
  const token = tokenRaw ?? ""

  const settings = (row.settings ?? {}) as { transport?: "socket-mode" | "events-api-webhook" }
  const transport: "socket-mode" | "events-api-webhook" =
    settings.transport === "events-api-webhook" ? "events-api-webhook" : "socket-mode"

  let selfId = ""
  try {
    const resp = await connectorsHttpRequest({
      url: "https://slack.com/api/auth.test",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
    })
    const parsed = JSON.parse(resp.body) as { ok: boolean; user_id?: string }
    if (parsed.ok && parsed.user_id) {
      selfId = parsed.user_id
    }
  } catch {
    // Non-fatal: selfId will be empty string; adapter still starts but may
    // not correctly detect self-mentions.
    console.warn(`[adapter-registry] auth.test failed for Slack adapter ${row.id}`)
  }

  return createSlackAdapter({
    id: row.id,
    displayName: row.displayName,
    botToken: () => connectorsKeyringGet(row.id, "botToken").then((t) => t ?? ""),
    appToken: () => connectorsKeyringGet(row.id, "appToken").then((t) => t ?? ""),
    signingSecret: () => connectorsKeyringGet(row.id, "signingSecret").then((t) => t ?? ""),
    selfId,
    transport,
  })
}

/**
 * Instantiate a Lark PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Reads App ID + App Secret from the keyring, obtains a tenant_access_token to
 * call /open-apis/bot/v3/info, and resolves the bot's own open_id (selfBotOpenId).
 * If the API call fails the adapter still starts — mention detection falls back to
 * checking the app_id in event headers.
 *
 * Caches a successful probe back to `row.settings.selfBotOpenId` so the
 * next cold start can skip the API call. The cache is invalidated by the
 * UI affordance `refreshSelfBotOpenId(adapterId)` (Settings → Lark form).
 */
export async function buildLarkAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const settings = (row.settings ?? {}) as {
    transport?: "long-connection" | "webhook"
    selfBotOpenId?: string
    quickCommands?: import("./adapters/lark/quick-commands").LarkQuickCommand[]
    [key: string]: unknown
  }
  const transport: "long-connection" | "webhook" =
    settings.transport === "webhook" ? "webhook" : "long-connection"

  const appIdRaw = await connectorsKeyringGet(row.id, "appId")
  const appId = appIdRaw ?? ""
  const appSecretRaw = await connectorsKeyringGet(row.id, "appSecret")
  const appSecret = appSecretRaw ?? ""

  // Resolve the bot's own open_id to enable accurate self-mention detection.
  let selfBotOpenId = settings.selfBotOpenId ?? ""

  // Skip the probe when we already have a cached open_id; the
  // `refreshSelfBotOpenId` affordance is the canonical way to flush a
  // stale cache.
  if (!selfBotOpenId) {
    try {
      const tat = await getTenantAccessToken({ appId, appSecret })
      const resp = await connectorsHttpRequest({
        url: "https://open.feishu.cn/open-apis/bot/v3/info",
        method: "GET",
        headers: { Authorization: `Bearer ${tat}` },
      })
      const parsed = JSON.parse(resp.body) as {
        code?: number
        bot?: { open_id?: string }
      }
      if (parsed.code === 0 && parsed.bot?.open_id) {
        selfBotOpenId = parsed.bot.open_id
        // Persist the resolved open_id back to the row so subsequent
        // cold starts skip this probe. Best-effort — a Dexie write
        // failure must not break adapter startup.
        try {
          await updateAdapterInstance(row.id, {
            settings: { ...settings, selfBotOpenId },
          })
        } catch (err) {
          console.warn(
            `[adapter-registry] failed to persist selfBotOpenId for ${row.id}:`,
            err instanceof Error ? err.message : String(err)
          )
        }
      }
    } catch {
      // Non-fatal: selfBotOpenId will be empty; adapter still starts but mention
      // detection may miss cases where the bot is addressed without an explicit @.
      console.warn(`[adapter-registry] bot/v3/info failed for Lark adapter ${row.id}`)
    }
  }

  return createLarkAdapter({
    id: row.id,
    displayName: row.displayName,
    appId: () => connectorsKeyringGet(row.id, "appId").then((v) => v ?? ""),
    appSecret: () => connectorsKeyringGet(row.id, "appSecret").then((v) => v ?? ""),
    encryptKey: () => connectorsKeyringGet(row.id, "encryptKey").then((v) => v ?? ""),
    verificationToken: () => connectorsKeyringGet(row.id, "verificationToken").then((v) => v ?? ""),
    selfBotOpenId,
    quickCommands: settings.quickCommands,
    transport,
  })
}

/**
 * Instantiate a OneBot PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Two transport directions are supported (selected by `row.transportMode`):
 *   - reverse-ws (default): the QQ client (NapCat/Lagrange/LLOneBot) dials
 *     cognia-next; transport starts when the WS connection is established.
 *   - forward-ws: cognia dials the NapCat WS server at
 *     `settings.forwardWsUrl` (e.g. `ws://host:3001`).
 *
 * NOTE: OneBot does not use OAuth. The only credential is the optional
 * bearer/access token (`onebotBearer`) stored in the keyring — for forward-ws
 * it is sent as `Authorization: Bearer`.
 */
export async function buildOneBotAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const settings = (row.settings ?? {}) as {
    selfBotUin?: string
    expectedClient?: "napcat" | "lagrange" | "llonebot"
    forwardWsUrl?: string
  }
  const selfBotUin = settings.selfBotUin ?? ""
  const transportMode = row.transportMode === "forward-ws" ? "forward-ws" : "reverse-ws"

  return createOneBotAdapter({
    id: row.id,
    displayName: row.displayName,
    selfBotUin,
    bearerToken: () => connectorsKeyringGet(row.id, "onebotBearer").then((t) => t ?? ""),
    expectedClient: settings.expectedClient,
    transportMode,
    forwardWsUrl: settings.forwardWsUrl,
  })
}

/**
 * Instantiate a WeCom 智能机器人 PlatformAdapter from a persisted row.
 *
 * Reads `botId` + `secret` from the keyring (the long-connection credentials)
 * and passes the non-secret settings (welcome message) through. No identity
 * probe is needed — the bot's `aibotid` arrives on the first inbound frame and
 * the adapter captures it as `selfId`.
 */
export async function buildWeComAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  return createWeComAdapter({
    id: row.id,
    displayName: row.displayName,
    botId: () => connectorsKeyringGet(row.id, "botId").then((v) => v ?? ""),
    secret: () => connectorsKeyringGet(row.id, "secret").then((v) => v ?? ""),
    settings: (row.settings ?? {}) as WeComAdapterSettings,
  })
}

/**
 * Instantiate a personal-WeChat (iLink) PlatformAdapter from a persisted row.
 *
 * Reads the iLink `botToken` from the keyring (obtained via the QR-login
 * wizard) and the per-session `baseUrl` from non-secret settings. iLink is a
 * reply-only HTTP long-poll channel; no identity probe.
 */
export async function buildWechatPersonalAdapter(
  row: AdapterInstanceRow
): Promise<PlatformAdapter> {
  const settings = (row.settings ?? {}) as { baseUrl?: string }
  return createWechatPersonalAdapter({
    id: row.id,
    displayName: row.displayName,
    token: () => connectorsKeyringGet(row.id, "botToken").then((v) => v ?? ""),
    baseUrl: async () => settings.baseUrl ?? "",
  })
}

// ---------------------------------------------------------------------------
// Lark self-bot open_id refresh (settings UI affordance)
// ---------------------------------------------------------------------------

export interface RefreshSelfBotOpenIdSuccess {
  ok: true
  openId: string
}

export interface RefreshSelfBotOpenIdFailure {
  ok: false
  reason: "not-lark" | "missing-credentials" | "tat-failed" | "api-failed"
  message: string
}

export type RefreshSelfBotOpenIdResult = RefreshSelfBotOpenIdSuccess | RefreshSelfBotOpenIdFailure

/**
 * Re-run the `/open-apis/bot/v3/info` probe the adapter normally runs at
 * startup, and persist the resolved `open_id` back to the adapter row's
 * `settings.selfBotOpenId` so the next cold start can skip the probe.
 *
 * Surfaced as an explicit affordance in the Lark form (Identity section →
 * "Refresh bot open_id") so when the silent startup probe fails the
 * operator can see why instead of guessing why mention detection is
 * degraded.
 */
export async function refreshSelfBotOpenId(adapterId: string): Promise<RefreshSelfBotOpenIdResult> {
  const row = await getAdapterInstance(adapterId)
  if (!row) {
    return { ok: false, reason: "missing-credentials", message: `Adapter not found: ${adapterId}` }
  }
  if (row.type !== "lark") {
    return {
      ok: false,
      reason: "not-lark",
      message: `Adapter type ${row.type} does not have a self bot open_id`,
    }
  }

  const appIdRaw = await connectorsKeyringGet(adapterId, "appId")
  const appSecretRaw = await connectorsKeyringGet(adapterId, "appSecret")
  const appId = appIdRaw ?? ""
  const appSecret = appSecretRaw ?? ""
  if (!appId || !appSecret) {
    return {
      ok: false,
      reason: "missing-credentials",
      message: "App ID and App Secret must be saved before refreshing the bot open_id",
    }
  }

  let tat: string
  try {
    tat = await getTenantAccessToken({ appId, appSecret })
  } catch (err) {
    return {
      ok: false,
      reason: "tat-failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }

  try {
    const resp = await connectorsHttpRequest({
      url: "https://open.feishu.cn/open-apis/bot/v3/info",
      method: "GET",
      headers: { Authorization: `Bearer ${tat}` },
    })
    // Lark /open-apis/bot/v3/info returns `{code, msg, bot: {open_id, ...}}`
    // (mirrors `whoami.ts`'s `LarkBotInfoResponse`). The earlier `data.open_id`
    // shape was a misread of the docs and made this affordance always fail.
    const parsed = JSON.parse(resp.body) as {
      code?: number
      msg?: string
      bot?: { open_id?: string }
    }
    if (parsed.code !== 0 || !parsed.bot?.open_id) {
      return {
        ok: false,
        reason: "api-failed",
        message: parsed.msg ?? `Lark returned code ${parsed.code ?? "?"}`,
      }
    }
    const openId = parsed.bot.open_id
    const nextSettings = { ...(row.settings ?? {}), selfBotOpenId: openId }
    await updateAdapterInstance(adapterId, { settings: nextSettings })
    return { ok: true, openId }
  } catch (err) {
    return {
      ok: false,
      reason: "api-failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
