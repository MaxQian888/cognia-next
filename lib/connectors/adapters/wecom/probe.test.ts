import { listen } from "@tauri-apps/api/event"
import { probeWeComCredentials } from "./probe"

const mockWsOpen = jest.fn()
const mockWsSend = jest.fn()
const mockWsClose = jest.fn()

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: (...a: unknown[]) => mockWsOpen(...a),
  connectorsWsSend: (...a: unknown[]) => mockWsSend(...a),
  connectorsWsClose: (...a: unknown[]) => mockWsClose(...a),
}))

const mockListen = listen as jest.Mock

type Handler = (e: { payload: string }) => void

function listenBus() {
  const listeners = new Map<string, Handler[]>()
  const impl = jest.fn(async (topic: string, handler: Handler) => {
    if (!listeners.has(topic)) listeners.set(topic, [])
    listeners.get(topic)!.push(handler)
    return jest.fn()
  })
  const trigger = (topic: string, payload: string) => {
    for (const h of listeners.get(topic) ?? []) h({ payload })
  }
  return { impl, trigger }
}

function sentSubscribeReqId(): string {
  const frame = JSON.parse(mockWsSend.mock.calls[0][1] as string) as { headers: { req_id: string } }
  return frame.headers.req_id
}

async function waitForSubscribeReqId(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
    if (mockWsSend.mock.calls.length > 0) return sentSubscribeReqId()
  }
  throw new Error("subscribe frame was not sent")
}

beforeEach(() => {
  mockWsOpen.mockReset()
  mockWsSend.mockReset()
  mockWsClose.mockReset()
  mockListen.mockReset()
  mockWsOpen.mockResolvedValue("wecom-probe")
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
})

describe("probeWeComCredentials", () => {
  it("resolves ok after a successful aibot_subscribe ack and closes the probe socket", async () => {
    const bus = listenBus()
    mockListen.mockImplementation(bus.impl)

    const resultPromise = probeWeComCredentials("bot-id", "secret")
    const reqId = await waitForSubscribeReqId()
    bus.trigger(
      "connectors://ws/wecom-probe/message",
      JSON.stringify({ headers: { req_id: reqId }, errcode: 0, errmsg: "ok" })
    )

    await expect(resultPromise).resolves.toEqual({ ok: true })
    expect(mockWsOpen).toHaveBeenCalledWith("wss://openws.work.weixin.qq.com")
    expect(JSON.parse(mockWsSend.mock.calls[0][1] as string)).toMatchObject({
      cmd: "aibot_subscribe",
      body: { bot_id: "bot-id", secret: "secret" },
    })
    expect(mockWsClose).toHaveBeenCalledWith("wecom-probe")
  })

  it("returns the WeCom subscribe error when the credentials are rejected", async () => {
    const bus = listenBus()
    mockListen.mockImplementation(bus.impl)

    const resultPromise = probeWeComCredentials("bot-id", "bad-secret")
    const reqId = await waitForSubscribeReqId()
    bus.trigger(
      "connectors://ws/wecom-probe/message",
      JSON.stringify({ headers: { req_id: reqId }, errcode: 60020, errmsg: "bad secret" })
    )

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "subscribe failed: 60020 bad secret",
    })
    expect(mockWsClose).toHaveBeenCalledWith("wecom-probe")
  })
})
