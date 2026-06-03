import { deliverWebhook } from "./delivery"
import type { OutboundWebhookEvent, WebhookEgressEndpoint } from "@/types/remote-control"

const fetchMock = jest.fn()
global.fetch = fetchMock as unknown as typeof fetch

function endpoint(over: Partial<WebhookEgressEndpoint> = {}): WebhookEgressEndpoint {
  return {
    id: "ep_1",
    name: "test",
    url: "https://example.test/hook",
    headers: [{ name: "X-Custom", value: "yes" }],
    enabled: true,
    ...over,
  }
}

function event(): OutboundWebhookEvent {
  return {
    id: "msg_1",
    eventType: "task.complete",
    source: "scheduler",
    payload: { ok: true },
    occurredAt: "2026-06-03T00:00:00.000Z",
  }
}

describe("deliverWebhook", () => {
  beforeEach(() => jest.clearAllMocks())

  it("delivers signed (three headers) + custom headers, serializing the body once", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    const r = await deliverWebhook({ endpoint: endpoint(), event: event(), signingSecret: "whsec" })
    expect(r).toEqual({ ok: true, httpStatus: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers["webhook-id"]).toBe("msg_1")
    expect(headers["webhook-timestamp"]).toBe("1780444800")
    expect(headers["webhook-signature"]).toMatch(/^v1,/)
    expect(headers["X-Custom"]).toBe("yes")
    expect(typeof init.body).toBe("string")
  })

  it("omits the signature headers when no secret is configured", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 })
    await deliverWebhook({ endpoint: endpoint(), event: event() })
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers["webhook-signature"]).toBeUndefined()
    expect(headers["X-Custom"]).toBe("yes")
  })

  const instantSleep = { sleep: () => Promise.resolve() }

  it("retries on non-2xx then succeeds, keeping webhook-id stable across retries", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const r = await deliverWebhook(
      { endpoint: endpoint(), event: event(), signingSecret: "whsec" },
      instantSleep
    )

    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const id1 = (fetchMock.mock.calls[0][1].headers as Record<string, string>)["webhook-id"]
    const id2 = (fetchMock.mock.calls[1][1].headers as Record<string, string>)["webhook-id"]
    expect(id1).toBe(id2)
  })

  it("gives up after the retry budget with the last status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 })
    const r = await deliverWebhook({ endpoint: endpoint(), event: event() }, instantSleep)
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(4) // 1 + 3 retries
  })

  it("gives up with an error message on repeated network failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))
    const r = await deliverWebhook({ endpoint: endpoint(), event: event() }, instantSleep)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("ECONNREFUSED")
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
