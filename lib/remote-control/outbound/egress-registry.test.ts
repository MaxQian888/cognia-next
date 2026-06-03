import { publishOutboundEvent } from "./egress-registry"
import type { OutboundWebhookEvent, WebhookEgressEndpoint } from "@/types/remote-control"

const deliverWebhook = jest.fn()
jest.mock("./delivery", () => ({ deliverWebhook: (...a: unknown[]) => deliverWebhook(...a) }))

const isTauri = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauri() }))

const remoteControlGetSigningSecret = jest.fn()
jest.mock("@/lib/tauri/remote-control", () => ({
  remoteControlGetSigningSecret: () => remoteControlGetSigningSecret(),
}))

const appendRemoteControlAudit = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/remote-control-audit", () => ({
  appendRemoteControlAudit: (...a: unknown[]) => appendRemoteControlAudit(...a),
}))

let endpoints: WebhookEgressEndpoint[] = []
jest.mock("@/stores/remote-control/store", () => ({
  useRemoteControlStore: {
    getState: () => ({ config: { outbound: { endpoints } } }),
  },
}))

function event(): OutboundWebhookEvent {
  return {
    id: "msg_1",
    eventType: "task.complete",
    source: "scheduler",
    payload: {},
    occurredAt: "2026-06-03T00:00:00.000Z",
  }
}

function ep(over: Partial<WebhookEgressEndpoint> = {}): WebhookEgressEndpoint {
  return { id: "ep_1", name: "a", url: "https://a.test", headers: [], enabled: true, ...over }
}

describe("publishOutboundEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    endpoints = []
    isTauri.mockReturnValue(false)
    deliverWebhook.mockResolvedValue({ ok: true, httpStatus: 200 })
  })

  it("returns empty and does nothing when there are no enabled endpoints", async () => {
    endpoints = [ep({ enabled: false })]
    const out = await publishOutboundEvent(event())
    expect(out).toEqual([])
    expect(deliverWebhook).not.toHaveBeenCalled()
  })

  it("fans out to every enabled endpoint", async () => {
    endpoints = [
      ep({ id: "ep_1" }),
      ep({ id: "ep_2", url: "https://b.test" }),
      ep({ id: "ep_3", enabled: false }),
    ]
    const out = await publishOutboundEvent(event())
    expect(deliverWebhook).toHaveBeenCalledTimes(2)
    expect(out.map((o) => o.endpointId)).toEqual(["ep_1", "ep_2"])
  })

  it("writes a durable audit row per delivery", async () => {
    endpoints = [ep({ id: "ep_1" })]
    deliverWebhook.mockResolvedValueOnce({ ok: false, httpStatus: 500, error: "http 500" })
    await publishOutboundEvent(event())
    expect(appendRemoteControlAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "outbound",
        kind: "outbound.failed",
        endpointId: "ep_1",
        httpStatus: 500,
      })
    )
  })

  it("resolves the signing secret from the keyring on desktop", async () => {
    isTauri.mockReturnValue(true)
    remoteControlGetSigningSecret.mockResolvedValue("whsec_live")
    endpoints = [ep()]
    await publishOutboundEvent(event())
    expect(deliverWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ signingSecret: "whsec_live" })
    )
  })

  it("passes no secret on web", async () => {
    isTauri.mockReturnValue(false)
    endpoints = [ep()]
    await publishOutboundEvent(event())
    expect(deliverWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ signingSecret: undefined })
    )
  })
})
