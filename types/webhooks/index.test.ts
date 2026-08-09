import {
  DEFAULT_WEBHOOK_DELIVERY,
  endpointSubscribesTo,
  normalizeWebhookDelivery,
  type WebhookEndpoint,
} from "./index"

const endpoint: WebhookEndpoint = {
  id: "ep_1",
  name: "test",
  url: "https://example.test",
  headers: [],
  enabled: true,
}

describe("webhook contracts", () => {
  it("treats an absent or empty subscription list as all events", () => {
    expect(endpointSubscribesTo(endpoint, "complete")).toBe(true)
    expect(endpointSubscribesTo({ ...endpoint, eventTypes: [] }, "complete")).toBe(true)
    expect(endpointSubscribesTo({ ...endpoint, eventTypes: ["error"] }, "complete")).toBe(false)
  })

  it("fills, rounds, and clamps delivery limits", () => {
    expect(normalizeWebhookDelivery()).toEqual(DEFAULT_WEBHOOK_DELIVERY)
    expect(
      normalizeWebhookDelivery({ maxRetries: 2.7, timeoutMs: 10, baseDelayMs: 99_999 })
    ).toEqual({ maxRetries: 3, timeoutMs: 1000, baseDelayMs: 60_000 })
    expect(normalizeWebhookDelivery({ timeoutMs: Number.NaN }).timeoutMs).toBe(
      DEFAULT_WEBHOOK_DELIVERY.timeoutMs
    )
  })
})
