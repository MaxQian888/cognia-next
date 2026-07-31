/**
 * Discord bot identity probe (im-refactored-crayon).
 *
 * Calls Discord's `GET /users/@me` with the bot token to surface the bot
 * user identity (name + avatar hash + snowflake id), and
 * `GET /applications/@me` for the real application id — `/users/@me`
 * returns the bot USER, which has no application id field.
 */

import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"

export interface DiscordWhoamiResult {
  botName: string
  botAvatar?: string
  /**
   * Discord application id, probed via `GET /applications/@me`. When that
   * probe fails the bot USER id is used instead (Discord guarantees the two
   * are equal for bots created since 2021) — never the username.
   */
  appId: string
  /** Bot user snowflake id (from `/users/@me`) — used for self-mention detection. */
  openId: string
}

export class DiscordWhoamiError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = "DiscordWhoamiError"
  }
}

/** The bot's user object from `GET /users/@me` (fields we consume). */
export interface DiscordBotUser {
  id: string
  username?: string
  global_name?: string
  discriminator?: string
  avatar?: string
  bot?: boolean
}

interface DiscordUserResponse extends Partial<DiscordBotUser> {
  message?: string
}

const DISCORD_USERS_ME = "https://discord.com/api/v10/users/@me"
const DISCORD_APPLICATIONS_ME = "https://discord.com/api/v10/applications/@me"

function discordAvatarUrl(userId: string, avatarHash?: string): string | undefined {
  if (!avatarHash) return undefined
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`
}

/**
 * Fetch the bot's own user via `GET /users/@me`. Shared by the whoami probe
 * and `adapter-registry.buildDiscordAdapter` (selfId resolution) so the HTTP
 * probe exists exactly once. Throws {@link DiscordWhoamiError} on any
 * HTTP/shape failure.
 */
export async function fetchDiscordBotUser(token: string): Promise<DiscordBotUser> {
  const resp = await connectorsHttpRequest({
    url: DISCORD_USERS_ME,
    method: "GET",
    headers: { Authorization: `Bot ${token}` },
  })

  if (resp.status >= 400) {
    throw new DiscordWhoamiError(
      `Discord /users/@me returned HTTP ${resp.status}: ${resp.body}`,
      resp.status
    )
  }

  const parsed = (resp.body ? JSON.parse(resp.body) : null) as DiscordUserResponse | null
  if (!parsed?.id) {
    throw new DiscordWhoamiError(
      `Discord /users/@me returned no id: ${parsed?.message ?? resp.body}`,
      resp.status
    )
  }
  return parsed as DiscordBotUser
}

/**
 * Best-effort application-id probe via `GET /applications/@me` (works with a
 * Bot token). Returns undefined on any failure so the caller can fall back
 * to the bot user id.
 */
async function fetchDiscordApplicationId(token: string): Promise<string | undefined> {
  try {
    const resp = await connectorsHttpRequest({
      url: DISCORD_APPLICATIONS_ME,
      method: "GET",
      headers: { Authorization: `Bot ${token}` },
    })
    if (resp.status >= 400) return undefined
    const parsed = (resp.body ? JSON.parse(resp.body) : null) as { id?: unknown } | null
    return typeof parsed?.id === "string" && parsed.id ? parsed.id : undefined
  } catch {
    return undefined
  }
}

export interface ProbeDiscordOptions {
  now?: () => number
}

export async function probeDiscordIdentity(
  adapterId: string,
  options: ProbeDiscordOptions = {}
): Promise<DiscordWhoamiResult> {
  const now = options.now ?? Date.now

  const row = await getAdapterInstance(adapterId)
  if (!row) throw new DiscordWhoamiError(`Adapter ${adapterId} does not exist`)
  if (row.type !== "discord") {
    throw new DiscordWhoamiError(`Adapter ${adapterId} is type=${row.type}, expected "discord"`)
  }

  const token = await connectorsKeyringGet(adapterId, "botToken")
  if (!token) {
    throw new DiscordWhoamiError(`Bot token is not configured for adapter ${adapterId}`)
  }

  const parsed = await fetchDiscordBotUser(token)
  const applicationId = await fetchDiscordApplicationId(token)

  const displayName = parsed.global_name ?? parsed.username ?? `bot-${parsed.id}`
  const result: DiscordWhoamiResult = {
    botName: parsed.discriminator ? `${displayName}#${parsed.discriminator}` : displayName,
    // Real application id when the probe succeeds; bot user id otherwise
    // (equal for post-2021 bots) — see the DiscordWhoamiResult docs.
    appId: applicationId ?? parsed.id,
    openId: parsed.id,
  }
  const avatar = discordAvatarUrl(parsed.id, parsed.avatar)
  if (avatar) result.botAvatar = avatar

  await updateAdapterInstance(adapterId, {
    lastWhoamiResult: result,
    lastWhoamiAt: now(),
  })

  return result
}
