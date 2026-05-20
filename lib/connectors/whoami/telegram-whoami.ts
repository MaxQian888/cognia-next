/**
 * Telegram bot identity probe (im-refactored-crayon).
 *
 * Calls Telegram's `/getMe` endpoint with the bot token from the
 * keyring and persists the result into `adapterInstances.lastWhoamiResult`
 * so the Adapters → Config detail tab can show "Connected as @bot_name".
 *
 * Lives under `lib/connectors/whoami/` alongside the other platform
 * probes; the dispatcher in `lib/connectors/whoami.ts` picks the right
 * one by `row.type`.
 */

import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"

export interface TelegramWhoamiResult {
  botName: string
  botAvatar?: string
  appId: string
  openId: string
}

export class TelegramWhoamiError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly apiOk?: boolean
  ) {
    super(message)
    this.name = "TelegramWhoamiError"
  }
}

interface TelegramGetMeResponse {
  ok: boolean
  description?: string
  result?: {
    id: number
    is_bot: boolean
    first_name?: string
    username?: string
  }
}

export interface ProbeTelegramOptions {
  now?: () => number
}

/**
 * Probe Telegram's `/getMe` for the bot identity associated with
 * `adapterId`. Throws `TelegramWhoamiError` on any failure; on success
 * persists `lastWhoamiResult` + `lastWhoamiAt`.
 */
export async function probeTelegramIdentity(
  adapterId: string,
  options: ProbeTelegramOptions = {}
): Promise<TelegramWhoamiResult> {
  const now = options.now ?? Date.now

  const row = await getAdapterInstance(adapterId)
  if (!row) throw new TelegramWhoamiError(`Adapter ${adapterId} does not exist`)
  if (row.type !== "telegram") {
    throw new TelegramWhoamiError(`Adapter ${adapterId} is type=${row.type}, expected "telegram"`)
  }

  const token = await connectorsKeyringGet(adapterId, "botToken")
  if (!token) {
    throw new TelegramWhoamiError(`Bot token is not configured for adapter ${adapterId}`)
  }

  const resp = await connectorsHttpRequest({
    url: `https://api.telegram.org/bot${token}/getMe`,
    method: "GET",
  })

  if (resp.status >= 400) {
    throw new TelegramWhoamiError(
      `Telegram /getMe returned HTTP ${resp.status}: ${resp.body}`,
      resp.status
    )
  }

  const parsed = (resp.body ? JSON.parse(resp.body) : null) as TelegramGetMeResponse | null
  if (!parsed?.ok || !parsed.result) {
    throw new TelegramWhoamiError(
      `Telegram /getMe failed: ${parsed?.description ?? "unknown"}`,
      resp.status,
      parsed?.ok
    )
  }

  const name = parsed.result.username
    ? `@${parsed.result.username}`
    : (parsed.result.first_name ?? `bot-${parsed.result.id}`)

  const result: TelegramWhoamiResult = {
    botName: name,
    appId: parsed.result.username ?? String(parsed.result.id),
    openId: String(parsed.result.id),
  }

  await updateAdapterInstance(adapterId, {
    lastWhoamiResult: result,
    lastWhoamiAt: now(),
  })

  return result
}
