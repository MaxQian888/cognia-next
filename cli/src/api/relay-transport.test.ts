import type { TransportRtc, TransportRtcOptions } from "@/lib/tauri/transport-rtc"

import { classifyRelayCode, relayCommandChannel, type RelayRouteRecord } from "./relay-transport"

const mockImportSigningPrivateKey = jest.fn(async (..._args: unknown[]) => ({ key: "signing" }))
jest.mock("@/lib/signaling/crypto", () => ({
  importSigningPrivateKey: (...args: unknown[]) => mockImportSigningPrivateKey(...args),
}))

const route: RelayRouteRecord = {
  rendezvousId: "dev-room",
  roomDescriptor: { v: 2, roomId: "dev-room" } as never,
  signalingPrivateKeyJwk: { kty: "EC", d: "secret" },
  signalingUrl: "wss://relay.example/signaling",
}

function fakeRtc(call: jest.Mock, connect = jest.fn(async () => undefined)) {
  const close = jest.fn()
  const rtc = { connect, call, close } as unknown as TransportRtc
  const factory = jest.fn((_options: TransportRtcOptions) => rtc)
  return { factory, close, connect }
}

beforeEach(() => mockImportSigningPrivateKey.mockClear())

describe("relayCommandChannel", () => {
  it("joins the device's own room relay-only, once, and carries commands", async () => {
    const call = jest.fn(async () => ({ hostId: "h" }))
    const rtc = fakeRtc(call)
    const channel = relayCommandChannel({ route, deviceId: "dev_9", transportFactory: rtc.factory })

    await expect(channel.execute("host_capabilities", {})).resolves.toEqual({
      ok: true,
      result: { hostId: "h" },
    })
    await channel.execute("host_feature_manifest", {}, { idempotencyKey: "k1", timeoutMs: 1000 })

    expect(rtc.factory).toHaveBeenCalledTimes(1)
    expect(rtc.factory.mock.calls[0]?.[0]).toMatchObject({
      signalingUrl: "wss://relay.example/signaling",
      rendezvousId: "dev-room",
      deviceId: "dev_9",
      role: "mobile",
      p2p: false,
      persistEventCursor: false,
      signalingPrivateKey: { key: "signing" },
    })
    expect(mockImportSigningPrivateKey).toHaveBeenCalledWith(route.signalingPrivateKeyJwk)
    expect(call).toHaveBeenLastCalledWith(
      "host_feature_manifest",
      {},
      expect.objectContaining({ idempotencyKey: "k1", deadlineAt: expect.any(Number) })
    )
    channel.close()
    await Promise.resolve()
    expect(rtc.close).toHaveBeenCalled()
  })

  it("reports an accepted command with its operation id", async () => {
    const rtc = fakeRtc(jest.fn(async () => ({ operationId: "op_1", status: "running" })))
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    await expect(channel.execute("agent_run", {})).resolves.toMatchObject({
      ok: true,
      accepted: true,
      operationId: "op_1",
    })
  })

  it("keeps a host refusal apart from not reaching the host", async () => {
    const refusal = Object.assign(new Error("device revoked"), { code: "device_revoked" })
    const rtc = fakeRtc(
      jest
        .fn()
        .mockRejectedValueOnce(refusal)
        .mockRejectedValueOnce(new Error("TransportRtc: RPC 'x' timed out"))
        .mockRejectedValueOnce(new Error("carrier closed"))
    )
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    await expect(channel.execute("x", {})).resolves.toEqual({
      ok: false,
      cause: "auth",
      message: "device revoked",
      code: "device_revoked",
    })
    await expect(channel.execute("x", {})).resolves.toMatchObject({ cause: "timeout" })
    await expect(channel.execute("x", {})).resolves.toMatchObject({ cause: "network" })
  })

  it("does not cache a room that could not be joined", async () => {
    const connect = jest
      .fn()
      .mockRejectedValueOnce(new Error("relay unreachable"))
      .mockResolvedValueOnce(undefined)
    const rtc = fakeRtc(
      jest.fn(async () => "ok"),
      connect
    )
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    await expect(channel.execute("x", {})).resolves.toMatchObject({
      ok: false,
      cause: "network",
      message: expect.stringContaining("relay unreachable"),
    })
    await expect(channel.execute("x", {})).resolves.toEqual({ ok: true, result: "ok" })
    expect(rtc.factory).toHaveBeenCalledTimes(2)
  })

  it("refuses after it was closed", async () => {
    const rtc = fakeRtc(jest.fn())
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    channel.close()
    await expect(channel.execute("x", {})).resolves.toMatchObject({ ok: false, cause: "network" })
    expect(rtc.factory).not.toHaveBeenCalled()
  })
})

describe("classifyRelayCode", () => {
  it("reads the host's problem codes in the direct wire's vocabulary", () => {
    expect(classifyRelayCode("unknown_command")).toBe("unknown-command")
    expect(classifyRelayCode("interactive_approval_required")).toBe("refused")
    expect(classifyRelayCode("rate_limited")).toBe("refused")
    expect(classifyRelayCode("device_revoked")).toBe("auth")
    expect(classifyRelayCode("invalid_params")).toBe("invalid-request")
    expect(classifyRelayCode("timeout")).toBe("timeout")
    expect(classifyRelayCode("internal")).toBe("failed")
    expect(classifyRelayCode(undefined)).toBe("failed")
  })
})
