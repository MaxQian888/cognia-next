/**
 * Slack bot identity probe (im-refactored-crayon).
 *
 * Calls Slack's `auth.test` endpoint with the bot token to surface
 * team + user + url. Persists the result into
 * `adapterInstances.lastWhoamiResult`.
 */

import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { buildSelfIdentity } from "@/lib/connectors/self-identity"
import type { AdapterSelfIdentitySnapshot } from "@/lib/db/connector-types"

export interface SlackWhoamiResult {
  botName: string
  /**
   * Slack app id. `auth.test` does NOT return one (`api_app_id` only rides
   * on event envelopes), so this stays "" rather than mislabeling the
   * bot_id as an app id. Kept because the shared `lastWhoamiResult` row
   * shape requires the field.
   */
  appId: string
  /** Team-scoped bot id (`B…`) from auth.test. */
  botId?: string
  openId: string
  tenantKey?: string
}

export class SlackWhoamiError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly slackOk?: boolean
  ) {
    super(message)
    this.name = "SlackWhoamiError"
  }
}

interface SlackAuthTestResponse {
  ok: boolean
  error?: string
  url?: string
  team?: string
  user?: string
  team_id?: string
  user_id?: string
  bot_id?: string
}

const SLACK_AUTH_TEST = "https://slack.com/api/auth.test"

export interface ProbeSlackOptions {
  now?: () => number
  /**
   * Which probe is asking. Defaults to `"whoami"` (the settings panel);
   * the supervisor passes `"startup_probe"` when confirming identity as
   * part of starting the adapter. Recorded on the identity snapshot so an
   * operator can tell a confirmed-at-start bot from one that has only ever
   * been probed by hand.
   */
  source?: AdapterSelfIdentitySnapshot["source"]
}

export async function probeSlackIdentity(
  adapterId: string,
  options: ProbeSlackOptions = {}
): Promise<SlackWhoamiResult> {
  const now = options.now ?? Date.now

  const row = await getAdapterInstance(adapterId)
  if (!row) throw new SlackWhoamiError(`Adapter ${adapterId} does not exist`)
  if (row.type !== "slack") {
    throw new SlackWhoamiError(`Adapter ${adapterId} is type=${row.type}, expected "slack"`)
  }

  const token = await connectorsKeyringGet(adapterId, "botToken")
  if (!token) {
    throw new SlackWhoamiError(`Bot token is not configured for adapter ${adapterId}`)
  }

  const resp = await connectorsHttpRequest({
    url: SLACK_AUTH_TEST,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "",
  })

  if (resp.status >= 400) {
    throw new SlackWhoamiError(
      `Slack auth.test returned HTTP ${resp.status}: ${resp.body}`,
      resp.status
    )
  }

  const parsed = (resp.body ? JSON.parse(resp.body) : null) as SlackAuthTestResponse | null
  if (!parsed?.ok || !parsed.user_id) {
    throw new SlackWhoamiError(
      `Slack auth.test failed: ${parsed?.error ?? "unknown"}`,
      resp.status,
      parsed?.ok
    )
  }

  const name = parsed.user
    ? parsed.team
      ? `${parsed.user} @ ${parsed.team}`
      : parsed.user
    : `bot-${parsed.user_id}`

  const result: SlackWhoamiResult = {
    botName: name,
    appId: "",
    botId: parsed.bot_id,
    openId: parsed.user_id,
    tenantKey: parsed.team_id,
  }

  await updateAdapterInstance(adapterId, {
    // The sibling-bot guard's authority — see `lib/connectors/self-identity.ts`.
    selfIdentity: buildSelfIdentity(
      {
        platformAccountId: result.openId,
        platformBotId: result.botId,
        source: options.source ?? "whoami",
      },
      now
    ),
    lastWhoamiResult: result,
    lastWhoamiAt: now(),
  })

  return result
}
