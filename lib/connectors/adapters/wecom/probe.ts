import { listen } from "@tauri-apps/api/event"
import {
  connectorsWsClose,
  connectorsWsOpen,
  connectorsWsSend,
} from "@/lib/connectors/tauri/commands"
import { WECOM_WS_URL, buildSubscribeFrame, newReqId, type WeComFrameEnvelope } from "./protocol"

export type WeComCredentialProbeResult = { ok: true } | { ok: false; error: string }

// GAP: this probe opens a SECOND `aibot_subscribe` connection with the same
// bot credentials, but WeCom allows exactly ONE long connection per bot — a
// settings-form "test connection" while the adapter is running can kick the
// live socket (or be kicked by it) and disrupt an active conversation. Left
// unfixed deliberately: a real fix routes the probe through the running
// adapter instead of a throwaway socket.
export async function probeWeComCredentials(
  botId: string,
  secret: string,
  timeoutMs = 15_000
): Promise<WeComCredentialProbeResult> {
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
      resolveOnce({ ok: false, error: "subscribe probe timed out" })
    }, timeoutMs)

    unlisten = await listen<string>(`connectors://ws/${handleId}/message`, (event) => {
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
        })
        return
      }
      resolveOnce({ ok: true })
    })

    await connectorsWsSend(handleId, JSON.stringify(buildSubscribeFrame(reqId, botId, secret)))
    return await result
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
    unlisten?.()
    if (handleId) await connectorsWsClose(handleId).catch(() => undefined)
  }
}
