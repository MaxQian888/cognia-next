/**
 * Adapter factory registry — Task 41 + Task 68.
 *
 * Switch on AdapterInstanceRow.type to instantiate the correct PlatformAdapter.
 * Phase 1 ships Telegram and Discord; subsequent phases extend the switch.
 */

import type { PlatformAdapter } from "@/types/connectors"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { createTelegramAdapter } from "./adapters/telegram"
import { createDiscordAdapter } from "./adapters/discord"

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
