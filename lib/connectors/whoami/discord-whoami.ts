/**
 * Discord bot identity probe (im-refactored-crayon).
 *
 * Calls Discord's `GET /users/@me` with the bot token to surface the
 * application identity (bot name + avatar hash + snowflake id).
 */

import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"

export interface DiscordWhoamiResult {
  botName: string
  botAvatar?: string
  appId: string
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

interface DiscordUserResponse {
  id?: string
  username?: string
  global_name?: string
  discriminator?: string
  avatar?: string
  bot?: boolean
  message?: string
}

const DISCORD_USERS_ME = "https://discord.com/api/v10/users/@me"

function discordAvatarUrl(userId: string, avatarHash?: string): string | undefined {
  if (!avatarHash) return undefined
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`
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

  const displayName = parsed.global_name ?? parsed.username ?? `bot-${parsed.id}`
  const result: DiscordWhoamiResult = {
    botName: parsed.discriminator ? `${displayName}#${parsed.discriminator}` : displayName,
    appId: parsed.username ?? parsed.id,
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
