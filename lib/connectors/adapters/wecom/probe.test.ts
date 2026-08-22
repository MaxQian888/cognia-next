import { listen } from "@tauri-apps/api/event"
import { probeWeComCredentials } from "./probe"
import {
  __resetWeComLiveConnectionsForTests,
  registerWeComLiveConnection,
  weComCredentialFingerprint,
} from "./live-connection"
import type { AdapterHealth } from "@/types/connectors/adapter"

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
  // Macrotask ticks, not microtask ones: the live-connection check hashes the
  // credentials through Web Crypto before any socket is opened, and that does
  // not settle on the microtask queue.
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
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
  __resetWeComLiveConnectionsForTests()
})

async function registerLive(
  botId: string,
  secret: string,
  health: AdapterHealth = { state: "running" }
): Promise<void> {
  registerWeComLiveConnection({
    adapterId: "wecom-1",
    botId,
    credentialFingerprint: await weComCredentialFingerprint(botId, secret),
    health: () => health,
  })
}

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

    await expect(resultPromise).resolves.toEqual({ ok: true, source: "probe_connection" })
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
      code: "probe_failed",
    })
    expect(mockWsClose).toHaveBeenCalledWith("wecom-probe")
  })

  describe("a bot that already holds its single connection", () => {
    it("answers from the running adapter without opening a second socket", async () => {
      await registerLive("bot-id", "secret")

      await expect(probeWeComCredentials("bot-id", "secret")).resolves.toEqual({
        ok: true,
        source: "live_connection",
      })
      // The whole point: the live conversation is never disturbed.
      expect(mockWsOpen).not.toHaveBeenCalled()
      expect(mockWsSend).not.toHaveBeenCalled()
    })

    it("reports the live adapter's failure reason rather than claiming success", async () => {
      await registerLive("bot-id", "secret", { state: "degraded", reason: "heartbeat lost" })

      await expect(probeWeComCredentials("bot-id", "secret")).resolves.toEqual({
        ok: false,
        error: "heartbeat lost",
        code: "probe_failed",
      })
      expect(mockWsOpen).not.toHaveBeenCalled()
    })

    it("names the state when a degraded adapter recorded no reason", async () => {
      await registerLive("bot-id", "secret", { state: "starting" })

      await expect(probeWeComCredentials("bot-id", "secret")).resolves.toEqual({
        ok: false,
        error: "adapter is starting",
        code: "probe_failed",
      })
    })

    it("refuses DIFFERENT credentials instead of racing for the slot", async () => {
      await registerLive("bot-id", "old-secret")

      const result = await probeWeComCredentials("bot-id", "new-secret")
      expect(result.ok).toBe(false)
      expect(result).toMatchObject({ code: "live_connection_conflict" })
      expect(mockWsOpen).not.toHaveBeenCalled()
    })

    it("lets a SAVE take the slot — replacing the connection is the point", async () => {
      const bus = listenBus()
      mockListen.mockImplementation(bus.impl)
      await registerLive("bot-id", "old-secret")

      const resultPromise = probeWeComCredentials("bot-id", "new-secret", { intent: "replace" })
      const reqId = await waitForSubscribeReqId()
      bus.trigger(
        "connectors://ws/wecom-probe/message",
        JSON.stringify({ headers: { req_id: reqId }, errcode: 0 })
      )

      await expect(resultPromise).resolves.toEqual({ ok: true, source: "probe_connection" })
    })

    it("still short-circuits a SAVE of the SAME credentials — nothing to replace", async () => {
      await registerLive("bot-id", "secret")

      await expect(
        probeWeComCredentials("bot-id", "secret", { intent: "replace" })
      ).resolves.toEqual({ ok: true, source: "live_connection" })
      expect(mockWsOpen).not.toHaveBeenCalled()
    })

    it("does not block a probe for a DIFFERENT bot — the limit is per bot", async () => {
      const bus = listenBus()
      mockListen.mockImplementation(bus.impl)
      await registerLive("bot-a", "secret-a")

      const resultPromise = probeWeComCredentials("bot-b", "secret-b")
      const reqId = await waitForSubscribeReqId()
      bus.trigger(
        "connectors://ws/wecom-probe/message",
        JSON.stringify({ headers: { req_id: reqId }, errcode: 0 })
      )

      await expect(resultPromise).resolves.toEqual({ ok: true, source: "probe_connection" })
      expect(mockWsOpen).toHaveBeenCalledTimes(1)
    })
  })
})
