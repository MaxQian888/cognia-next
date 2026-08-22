/**
 * Lark bot identity probe (schema v45, im-refactored-crayon).
 *
 * Calls Lark's `/open-apis/bot/v3/info` endpoint and persists the
 * response into `adapterInstances.lastWhoamiResult` so the Settings →
 * Adapter → Lark detail panel can confirm "we connected to the right
 * bot in the expected tenant" without leaving the page.
 *
 * The probe is best-effort: it reads credentials from the keyring, gets
 * a tenant access token via the existing cache, hits the bot info
 * endpoint, and on success writes the result + timestamp back into the
 * adapter row. On any failure the helper throws a descriptive error so
 * the UI can render it; the prior `lastWhoamiResult` is preserved.
 *
 * Why this is a separate module instead of folding into the adapter:
 *   - the dispatch loop in `adapters/lark/index.ts` already maintains
 *     a singleton AbortController; adding a "probe on demand" path
 *     there would force a re-entrancy story the rest of the lifecycle
 *     doesn't need.
 *   - the Settings UI must be able to call this probe BEFORE the
 *     adapter is enabled (during the initial save flow), which means
 *     it cannot depend on the adapter's running context.
 *   - dedicated module = clean test surface (no transport mock needed).
 */

import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { buildSelfIdentity } from "@/lib/connectors/self-identity"
import type { AdapterSelfIdentitySnapshot } from "@/lib/db/connector-types"
import { getTenantAccessToken } from "./auth"

const LARK_BOT_INFO_URL = "https://open.feishu.cn/open-apis/bot/v3/info"

/**
 * Result row written to `adapterInstances.lastWhoamiResult`.
 *
 * Optional fields are omitted from the persisted row when the bot info
 * endpoint did not return them (e.g. `botAvatar` for legacy bots).
 * `tenantKey` and `scopes` are always undefined here because the bot
 * info endpoint does not expose them — see the connector-types.ts
 * comments for why.
 */
export interface LarkWhoamiResult {
  botName: string
  botAvatar?: string
  appId: string
  openId: string
  activateStatus?: number
}

interface LarkBotInfoResponse {
  code: number
  msg?: string
  bot?: {
    app_name?: string
    avatar_url?: string
    open_id?: string
    activate_status?: number
    ip_white_list?: string[]
  }
}

/**
 * Thrown when the bot info probe fails. Carries the original Lark
 * `code` (or HTTP status if the request never reached the API) so the
 * UI can show actionable error copy without parsing the message.
 */
export class LarkWhoamiError extends Error {
  constructor(
    message: string,
    readonly larkCode?: number,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = "LarkWhoamiError"
  }
}

export interface ProbeBotIdentityOptions {
  /**
   * Override the default `now()` clock for `lastWhoamiAt`. Tests pass a
   * stable value; production code calls without it.
   */
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
 * Probe the Lark bot identity associated with `adapterId` and persist
 * the result into the adapter row.
 *
 * Throws `LarkWhoamiError` if:
 *   - the adapter row does not exist
 *   - the adapter is not of type "lark"
 *   - the keyring does not have the App ID / App Secret stored
 *   - the TAT fetch fails
 *   - the bot info endpoint returns a non-zero code or HTTP 4xx/5xx
 */
export async function probeBotIdentity(
  adapterId: string,
  options: ProbeBotIdentityOptions = {}
): Promise<LarkWhoamiResult> {
  const now = options.now ?? Date.now

  const row = await getAdapterInstance(adapterId)
  if (!row) {
    throw new LarkWhoamiError(`Adapter ${adapterId} does not exist`)
  }
  if (row.type !== "lark") {
    throw new LarkWhoamiError(`Adapter ${adapterId} is type=${row.type}, expected "lark"`)
  }

  const [appId, appSecret] = await Promise.all([
    connectorsKeyringGet(adapterId, "appId"),
    connectorsKeyringGet(adapterId, "appSecret"),
  ])
  if (!appId) {
    throw new LarkWhoamiError(`App ID is not configured for adapter ${adapterId}`)
  }
  if (!appSecret) {
    throw new LarkWhoamiError(`App Secret is not configured for adapter ${adapterId}`)
  }

  // Reuse the existing TAT cache. Throws on auth failure with a message
  // describing the Lark code + msg.
  const tat = await getTenantAccessToken({ appId, appSecret })

  const resp = await connectorsHttpRequest({
    url: LARK_BOT_INFO_URL,
    method: "GET",
    headers: {
      Authorization: `Bearer ${tat}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  })

  if (resp.status >= 400) {
    throw new LarkWhoamiError(
      `Lark /bot/v3/info returned HTTP ${resp.status}: ${resp.body}`,
      undefined,
      resp.status
    )
  }

  const parsed = (resp.body ? JSON.parse(resp.body) : null) as LarkBotInfoResponse | null
  if (!parsed || parsed.code !== 0 || !parsed.bot?.open_id) {
    throw new LarkWhoamiError(
      `Lark /bot/v3/info failed: code=${parsed?.code ?? "?"}, msg=${parsed?.msg ?? "unknown"}`,
      parsed?.code,
      resp.status
    )
  }

  const result: LarkWhoamiResult = {
    botName: parsed.bot.app_name ?? "Unknown",
    appId,
    openId: parsed.bot.open_id,
  }
  if (parsed.bot.avatar_url) result.botAvatar = parsed.bot.avatar_url
  if (typeof parsed.bot.activate_status === "number") {
    result.activateStatus = parsed.bot.activate_status
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
