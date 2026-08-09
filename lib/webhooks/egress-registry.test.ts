import { publishOutboundEvent } from "./egress-registry"
import type { OutboundWebhookEvent, WebhookEndpoint } from "@/types/webhooks"

const deliverWebhook = jest.fn()
jest.mock("./delivery", () => ({
  ...jest.requireActual<typeof import("./delivery")>("./delivery"),
  deliverWebhook: (...a: unknown[]) => deliverWebhook(...a),
}))

const getWebhookSigningSecret = jest.fn()
jest.mock("./signing-secret", () => ({
  getWebhookSigningSecret: () => getWebhookSigningSecret(),
}))

const appendWebhookAudit = jest.fn().mockResolvedValue(undefined)
jest.mock("./audit", () => ({
  appendWebhookAudit: (...args: unknown[]) => appendWebhookAudit(...args),
}))

let endpoints: WebhookEndpoint[] = []
let defaultHeaders: Array<{ name: string; value: string }> = []
let hasSigningSecret = false
const delivery: unknown = { maxRetries: 2, timeoutMs: 5000, baseDelayMs: 500 }
jest.mock("@/stores/webhooks/store", () => ({
  useWebhookStore: {
    getState: () => ({ config: { endpoints, defaultHeaders, hasSigningSecret, delivery } }),
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

function ep(over: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return { id: "ep_1", name: "a", url: "https://a.test", headers: [], enabled: true, ...over }
}

describe("publishOutboundEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    endpoints = []
    defaultHeaders = []
    hasSigningSecret = false
    getWebhookSigningSecret.mockResolvedValue(null)
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
    expect(appendWebhookAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "outbound",
        kind: "outbound.failed",
        endpointId: "ep_1",
        httpStatus: 500,
      })
    )
  })

  it("resolves the signing secret from the shared keyring", async () => {
    hasSigningSecret = true
    getWebhookSigningSecret.mockResolvedValue("whsec_live")
    endpoints = [ep()]
    await publishOutboundEvent(event())
    expect(deliverWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ signingSecret: "whsec_live" })
    )
  })

  it("fails closed when a configured signing secret cannot be read", async () => {
    hasSigningSecret = true
    getWebhookSigningSecret.mockRejectedValue(new Error("keyring offline"))
    endpoints = [ep()]

    await expect(publishOutboundEvent(event())).rejects.toThrow("keyring offline")
    expect(deliverWebhook).not.toHaveBeenCalled()
  })

  it("passes no secret when secure storage has no value", async () => {
    endpoints = [ep()]
    await publishOutboundEvent(event())
    expect(deliverWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ signingSecret: undefined })
    )
  })

  it("delivers only to endpoints subscribed to the event type", async () => {
    endpoints = [
      ep({ id: "ep_all" }), // no filter → all events
      ep({ id: "ep_match", eventTypes: ["task.complete"] }),
      ep({ id: "ep_miss", eventTypes: ["task.error"] }),
    ]
    const out = await publishOutboundEvent(event()) // eventType: task.complete
    expect(out.map((o) => o.endpointId)).toEqual(["ep_all", "ep_match"])
    expect(deliverWebhook).toHaveBeenCalledTimes(2)
  })

  it("forwards the configured delivery limits to each delivery", async () => {
    endpoints = [ep()]
    await publishOutboundEvent(event())
    expect(deliverWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ limits: { maxRetries: 2, timeoutMs: 5000, baseDelayMs: 500 } })
    )
  })

  it("merges default headers into every endpoint and lets endpoint values win", async () => {
    defaultHeaders = [
      { name: "X-Global", value: "yes" },
      { name: "X-Override", value: "global" },
    ]
    endpoints = [ep({ headers: [{ name: "X-Override", value: "endpoint" }] })]

    await publishOutboundEvent(event())

    expect(deliverWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: expect.objectContaining({
          headers: [
            { name: "X-Global", value: "yes" },
            { name: "X-Override", value: "endpoint" },
          ],
        }),
      })
    )
  })
})
