import { connectorListen } from "@/lib/connectors/events"
import {
  connectorsWsClose,
  connectorsWsOpen,
  connectorsWsSend,
} from "@/lib/connectors/tauri/commands"
import { WECOM_WS_URL, buildSubscribeFrame, newReqId, type WeComFrameEnvelope } from "./protocol"
import {
  findWeComLiveConnection,
  weComCredentialFingerprint,
  type WeComLiveConnection,
} from "./live-connection"

/**
 * Why a probe answered the way it did. `live_connection` means no socket was
 * opened — a running adapter is already subscribed with exactly these
 * credentials, which proves them more strongly than a throwaway connection
 * would. `probe_connection` is the classic path, taken only when this bot has
 * no live socket to disturb.
 */
export type WeComProbeSource = "live_connection" | "probe_connection"

/**
 * Determinate failure codes. `live_connection_conflict` is the one a caller
 * must handle rather than display: WeCom allows one connection per bot, so
 * testing DIFFERENT credentials for a bot that is currently connected cannot
 * be done without taking its slot. Stopping the bot first is the only safe
 * order, and that is the user's call to make.
 */
export type WeComProbeFailureCode = "live_connection_conflict" | "probe_failed"

export type WeComCredentialProbeResult =
  { ok: true; source: WeComProbeSource } | { ok: false; error: string; code: WeComProbeFailureCode }

/**
 * Why the caller is probing — it decides what happens when the bot is already
 * connected with DIFFERENT credentials.
 *
 * - `"test"` (default): the user pressed "test connection" and expects to learn
 *   something, not to lose a conversation. Refuse with
 *   `live_connection_conflict` rather than take the slot.
 * - `"replace"`: the credentials are being SAVED. Displacing the current
 *   connection is the user's intent — the adapter is about to reconnect with
 *   exactly these credentials — so the probe proceeds.
 */
export type WeComProbeIntent = "test" | "replace"

export interface WeComProbeOptions {
  timeoutMs?: number
  intent?: WeComProbeIntent
}

/** Project a live adapter's health into a probe answer. */
function fromLiveConnection(connection: WeComLiveConnection): WeComCredentialProbeResult {
  const health = connection.health()
  if (health.state === "running") return { ok: true, source: "live_connection" }
  return {
    ok: false,
    error: health.reason ?? `adapter is ${health.state}`,
    code: "probe_failed",
  }
}

export async function probeWeComCredentials(
  botId: string,
  secret: string,
  options: WeComProbeOptions = {}
): Promise<WeComCredentialProbeResult> {
  const { timeoutMs = 15_000, intent = "test" } = options
  const connection = findWeComLiveConnection(botId)
  if (connection) {
    const fingerprint = await weComCredentialFingerprint(botId, secret)
    // Same credentials: the running socket IS the proof. Never open a second
    // one, whatever the intent — there is nothing to replace.
    if (fingerprint === connection.credentialFingerprint) return fromLiveConnection(connection)
    if (intent === "test") {
      return {
        ok: false,
        code: "live_connection_conflict",
        error:
          `bot ${botId} already holds its single WeCom connection (adapter ${connection.adapterId}); ` +
          "stop it before testing different credentials",
      }
    }
  }

  let handleId: string | null = null
  let unlisten: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    handleId = await connectorsWsOpen(WECOM_WS_URL)
    const reqId = newReqId("probe")
    let settled = false
    let resolveResult!: (result: WeComCredentialProbeResult) => void
    const result = new Promise<WeComCredentialProbeResult>((resolve) => {
      resolveResult = resolve
    })
    const resolveOnce = (probeResult: WeComCredentialProbeResult) => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      resolveResult(probeResult)
    }

    timer = setTimeout(() => {
      resolveOnce({ ok: false, error: "subscribe probe timed out", code: "probe_failed" })
    }, timeoutMs)

    unlisten = await connectorListen<string>(`connectors://ws/${handleId}/message`, (event) => {
      let frame: WeComFrameEnvelope
      try {
        frame = JSON.parse(event.payload) as WeComFrameEnvelope
      } catch {
        return
      }
      if (frame.headers?.req_id !== reqId) return
      if (typeof frame.errcode === "number" && frame.errcode !== 0) {
        resolveOnce({
          ok: false,
          error: `subscribe failed: ${frame.errcode} ${frame.errmsg ?? ""}`.trim(),
          code: "probe_failed",
        })
        return
      }
      resolveOnce({ ok: true, source: "probe_connection" })
    })

    await connectorsWsSend(handleId, JSON.stringify(buildSubscribeFrame(reqId, botId, secret)))
    return await result
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: "probe_failed",
    }
  } finally {
    if (timer) clearTimeout(timer)
    unlisten?.()
    if (handleId) await connectorsWsClose(handleId).catch(() => undefined)
  }
}
