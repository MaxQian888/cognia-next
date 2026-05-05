/**
 * Adapter factory registry — Task 41 + Task 68 + Task 80 + Task 93.
 *
 * Switch on AdapterInstanceRow.type to instantiate the correct PlatformAdapter.
 * Phase 1 ships Telegram, Discord, Slack, and Lark.
 */

import type { PlatformAdapter } from "@/types/connectors"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { createTelegramAdapter } from "./adapters/telegram"
import { createDiscordAdapter } from "./adapters/discord"
import { createSlackAdapter } from "./adapters/slack"
import { createLarkAdapter } from "./adapters/lark"
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
 * TODO Phase 2: cache selfBotOpenId in the row settings so startup is faster on
 * subsequent launches.
 */
export async function buildLarkAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const settings = (row.settings ?? {}) as { transport?: "long-connection" | "webhook" }
  const transport: "long-connection" | "webhook" =
    settings.transport === "webhook" ? "webhook" : "long-connection"

  const appIdRaw = await connectorsKeyringGet(row.id, "appId")
  const appId = appIdRaw ?? ""
  const appSecretRaw = await connectorsKeyringGet(row.id, "appSecret")
  const appSecret = appSecretRaw ?? ""

  // Resolve the bot's own open_id to enable accurate self-mention detection.
  let selfBotOpenId = ""
  try {
    const tat = await getTenantAccessToken({ appId, appSecret })
    const resp = await connectorsHttpRequest({
      url: "https://open.feishu.cn/open-apis/bot/v3/info",
      method: "GET",
      headers: { Authorization: `Bearer ${tat}` },
    })
    const parsed = JSON.parse(resp.body) as {
      code?: number
      data?: { open_id?: string }
    }
    if (parsed.code === 0 && parsed.data?.open_id) {
      selfBotOpenId = parsed.data.open_id
    }
  } catch {
    // Non-fatal: selfBotOpenId will be empty; adapter still starts but mention
    // detection may miss cases where the bot is addressed without an explicit @.
    console.warn(`[adapter-registry] bot/v3/info failed for Lark adapter ${row.id}`)
  }

  return createLarkAdapter({
    id: row.id,
    displayName: row.displayName,
    appId: () => connectorsKeyringGet(row.id, "appId").then((v) => v ?? ""),
    appSecret: () => connectorsKeyringGet(row.id, "appSecret").then((v) => v ?? ""),
    encryptKey: () => connectorsKeyringGet(row.id, "encryptKey").then((v) => v ?? ""),
    verificationToken: () => connectorsKeyringGet(row.id, "verificationToken").then((v) => v ?? ""),
    selfBotOpenId,
    transport,
  })
}
