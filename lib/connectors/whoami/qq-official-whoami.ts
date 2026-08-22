/**
 * QQ Official Bot identity probe.
 *
 * Mints an app access token from the keyring `appId` + `clientSecret`
 * (reusing the adapter's cached `getQQAccessToken`) and calls
 * `GET https://api.sgroup.qq.com/users/@me` with `Authorization: QQBot
 * <token>`, then persists the result into
 * `adapterInstances.lastWhoamiResult` so the Adapters → Config detail tab
 * can show the connected bot identity.
 *
 * Lives under `lib/connectors/whoami/` alongside the other platform
 * probes; the shared `AdapterWhoamiPanel` dispatches to it by `row.type`.
 */

import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { buildSelfIdentity } from "@/lib/connectors/self-identity"
import type { AdapterSelfIdentitySnapshot } from "@/lib/db/connector-types"
import {
  QQ_API_BASE,
  getQQAccessToken,
  qqAuthHeaders,
} from "@/lib/connectors/adapters/qq-official/auth"

export interface QQOfficialWhoamiResult {
  botName: string
  botAvatar?: string
  appId: string
  openId: string
}

export class QQOfficialWhoamiError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = "QQOfficialWhoamiError"
  }
}

interface QQUsersMeResponse {
  id?: string
  username?: string
  avatar?: string
  message?: string
}

export interface ProbeQQOfficialOptions {
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

/**
 * Probe QQ's `/users/@me` for the bot identity associated with `adapterId`.
 * Throws `QQOfficialWhoamiError` on any failure; on success persists
 * `lastWhoamiResult` + `lastWhoamiAt`.
 */
export async function probeQQOfficialIdentity(
  adapterId: string,
  options: ProbeQQOfficialOptions = {}
): Promise<QQOfficialWhoamiResult> {
  const now = options.now ?? Date.now

  const row = await getAdapterInstance(adapterId)
  if (!row) throw new QQOfficialWhoamiError(`Adapter ${adapterId} does not exist`)
  if (row.type !== "qq-official") {
    throw new QQOfficialWhoamiError(
      `Adapter ${adapterId} is type=${row.type}, expected "qq-official"`
    )
  }

  const appId = await connectorsKeyringGet(adapterId, "appId")
  const clientSecret = await connectorsKeyringGet(adapterId, "clientSecret")
  if (!appId || !clientSecret) {
    throw new QQOfficialWhoamiError(
      `App ID / Client Secret are not configured for adapter ${adapterId}`
    )
  }

  let token: string
  try {
    token = await getQQAccessToken(appId, clientSecret)
  } catch (err) {
    throw new QQOfficialWhoamiError(err instanceof Error ? err.message : String(err))
  }

  const resp = await connectorsHttpRequest({
    url: `${QQ_API_BASE}/users/@me`,
    method: "GET",
    headers: qqAuthHeaders(token),
  })

  let parsed: QQUsersMeResponse | null
  try {
    parsed = resp.body ? (JSON.parse(resp.body) as QQUsersMeResponse) : null
  } catch {
    throw new QQOfficialWhoamiError(
      `QQ /users/@me returned non-JSON (status ${resp.status})`,
      resp.status
    )
  }

  if (resp.status >= 400 || !parsed?.id) {
    throw new QQOfficialWhoamiError(
      `QQ /users/@me failed: ${parsed?.message ?? resp.body.slice(0, 200)}`,
      resp.status
    )
  }

  const result: QQOfficialWhoamiResult = {
    botName: parsed.username ?? `bot-${parsed.id}`,
    ...(parsed.avatar ? { botAvatar: parsed.avatar } : {}),
    appId,
    openId: parsed.id,
  }

  await updateAdapterInstance(adapterId, {
    // The sibling-bot guard's authority — see `lib/connectors/self-identity.ts`.
    selfIdentity: buildSelfIdentity(
      {
        platformAccountId: result.openId,
        source: options.source ?? "whoami",
      },
      now
    ),
    lastWhoamiResult: result,
    lastWhoamiAt: now(),
  })

  return result
}
