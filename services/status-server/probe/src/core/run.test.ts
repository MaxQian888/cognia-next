import { describe, expect, it } from "vitest"

import { parseObservationBatch } from "../../../../../lib/status/validate"
import { FakeRelay, type FakeRelayOptions } from "../testing/fake-relay"
import { buildObservationBatch } from "./batch"
import { RelayBudget } from "./protocol-run"
import { runProbeChecks } from "./run"
import { MAX_ROOM_RELAY_BYTES, ProbeTransportError, type ProbeLimits } from "./types"

const URL_WSS = "wss://signaling.example.test/signaling"
const FAST: Partial<ProbeLimits> = {
  phaseTimeoutMs: 300,
  protocolDeadlineMs: 3_000,
  closeDeadlineMs: 200,
}

function run(
  relay: FakeRelay,
  opts: {
    origin?: string | null
    runHttp?: boolean
    runProtocol?: boolean
    limits?: Partial<ProbeLimits>
    signal?: AbortSignal
  } = {}
) {
  return runProbeChecks({
    signalingUrl: URL_WSS,
    profile: { id: opts.origin ? "web" : "native", origin: opts.origin ?? null },
    runHttp: opts.runHttp ?? true,
    runProtocol: opts.runProtocol ?? true,
    transport: relay,
    signal: opts.signal,
    limits: { ...FAST, ...opts.limits },
  })
}

function byId(checks: Awaited<ReturnType<typeof runProbeChecks>>["checks"]) {
  return Object.fromEntries(checks.map((check) => [check.checkId, check]))
}

async function protocolOnly(options: FakeRelayOptions, extra: Parameters<typeof run>[1] = {}) {
  const relay = new FakeRelay(options)
  const result = await run(relay, { runHttp: false, ...extra })
  return { relay, result, checks: byId(result.checks) }
}

function expectBatchValid(result: Awaited<ReturnType<typeof runProbeChecks>>) {
  const batch = buildObservationBatch({
    probeId: "ext-test",
    runId: "r-test-1",
    registryRevision: 1,
    scheduledAtMs: Math.floor(result.startedAtMs / 60_000) * 60_000,
    profileId: "native",
    result,
  })
  expect(parseObservationBatch(batch).ok).toBe(true)
}

describe("runProbeChecks happy path", () => {
  it("passes HTTP, authenticated signal and explicit data lane, then cleans up", async () => {
    const relay = new FakeRelay()
    const result = await run(relay)
    const checks = byId(result.checks)
    expect(result.checks.map((check) => check.checkId)).toEqual([
      "signalingHttp",
      "signalingAuth",
      "relayData",
    ])
    for (const check of result.checks) {
      expect(check).toMatchObject({
        result: "pass",
        reason: null,
        attempted: true,
        dependsOn: null,
      })
      expect(check.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect(checks.signalingAuth?.durationMs).toBeGreaterThanOrEqual(checks.relayData!.durationMs!)
    expect(result.aborted).toBe(false)
    // Two sockets, both unsubscribed and closed; native sends no Origin.
    expect(relay.sockets).toHaveLength(2)
    expect(relay.origins).toEqual([null, null])
    expect(relay.unsubscribes).toHaveLength(2)
    expect(relay.sockets.every((socket) => socket.isClosed)).toBe(true)
    // The data payload really went over `lane: "data"` both ways.
    const sentData = relay.sockets.flatMap((socket) => socket.sent).filter((f) => f.lane === "data")
    expect(sentData).toHaveLength(2)
    expectBatchValid(result)
  })

  it("sends the profile's exact Origin header on both upgrades", async () => {
    const relay = new FakeRelay({ allowedOrigins: ["capacitor://localhost"] })
    const result = await run(relay, { origin: "capacitor://localhost", runHttp: false })
    expect(relay.origins).toEqual(["capacitor://localhost", "capacitor://localhost"])
    expect(byId(result.checks).relayData?.result).toBe("pass")
  })

  it("keeps relay traffic well under the 1 MiB room budget", async () => {
    const relay = new FakeRelay()
    const result = await run(relay, { runHttp: false })
    expect(result.relayBytesSent).toBeGreaterThan(2 * 1024)
    expect(result.relayBytesSent).toBeLessThan(MAX_ROOM_RELAY_BYTES)
    expect(relay.relayPayloadBytes).toBe(result.relayBytesSent)
  })

  it("only runs the requested check classes", async () => {
    const relay = new FakeRelay()
    const httpOnly = await run(relay, { runProtocol: false })
    expect(httpOnly.checks.map((check) => check.checkId)).toEqual(["signalingHttp"])
    expect(relay.sockets).toHaveLength(0)
    const protocol = await run(new FakeRelay(), { runHttp: false })
    expect(protocol.checks.map((check) => check.checkId)).toEqual(["signalingAuth", "relayData"])
  })
})

describe("signalingAuth failures make relayData a dependency gap", () => {
  const dependencyGap = {
    checkId: "relayData",
    result: "unknown",
    durationMs: null,
    reason: "dependency_failed",
    attempted: false,
    dependsOn: "signalingAuth",
  }

  it.each<[string, FakeRelayOptions, Parameters<typeof run>[1], string]>([
    [
      "forbidden Origin",
      { allowedOrigins: ["https://cognia.cn"] },
      { origin: "https://evil.example" },
      "origin_rejected",
    ],
    [
      "403 without Origin is a plain upgrade failure",
      { upgradeError: () => new ProbeTransportError("ws_upgrade", "403", 403) },
      {},
      "ws_upgrade",
    ],
    [
      "other upgrade failure",
      { upgradeError: () => new ProbeTransportError("ws_upgrade", "502", 502) },
      {},
      "ws_upgrade",
    ],
    ["DNS failure", { upgradeError: () => new ProbeTransportError("dns_error") }, {}, "dns_error"],
    ["TLS failure", { upgradeError: () => new ProbeTransportError("tls_error") }, {}, "tls_error"],
    ["server auth_failed", { rejectRoles: ["mobile"] }, {}, "auth_rejected"],
    ["subscribe never answered", { silentSubscribe: true }, {}, "auth_timeout"],
    ["no peerJoined", { suppressPeerJoined: true }, {}, "peer_timeout"],
    ["snapshot lacks desktop proof", { tamperSnapshot: true }, {}, "relay_mismatch"],
    [
      "signal relay dropped",
      { onRelay: (frame, ctx) => (ctx.step === "signal" ? null : frame) },
      {},
      "relay_timeout",
    ],
    [
      "signal ack corrupted",
      {
        onRelay: (frame, ctx) =>
          ctx.step === "signal-ack"
            ? { ...frame, payload: String(frame.payload).replace("}", ',"x":1}') }
            : frame,
      },
      {},
      "relay_mismatch",
    ],
    ["socket closed during signal", { closeOnStep: "signal" }, {}, "ws_closed"],
  ])("%s", async (_label, options, extra, reason) => {
    const { relay, checks } = await protocolOnly(options, extra)
    expect(checks.signalingAuth).toMatchObject({ result: "fail", reason, attempted: true })
    expect(checks.signalingAuth?.durationMs).toBeGreaterThanOrEqual(0)
    expect(checks.relayData).toEqual(dependencyGap)
    expect(relay.sockets.every((socket) => socket.isClosed)).toBe(true)
  })

  it("does not let HTTP success hide an auth failure, or vice versa", async () => {
    const relay = new FakeRelay({ rejectRoles: ["desktop"] })
    const checks = byId((await run(relay)).checks)
    expect(checks.signalingHttp?.result).toBe("pass")
    expect(checks.signalingAuth?.result).toBe("fail")
  })
})

describe("relayData fails independently once auth passed", () => {
  it.each<[string, FakeRelayOptions, string]>([
    [
      "data payload corrupted",
      {
        onRelay: (frame, ctx) =>
          ctx.step === "data"
            ? { ...frame, payload: String(frame.payload).replace(/"data":"./, '"data":"!') }
            : frame,
      },
      "relay_mismatch",
    ],
    [
      "data echo delivered on the signal lane",
      {
        onRelay: (frame, ctx) => {
          if (ctx.step !== "data-echo") return frame
          const { lane: _lane, ...rest } = frame
          return rest
        },
      },
      "relay_mismatch",
    ],
    [
      "data relay dropped",
      { onRelay: (frame, ctx) => (ctx.step === "data" ? null : frame) },
      "relay_timeout",
    ],
    [
      // The relay answers the *sender* with the error and delivers nothing to
      // the receiver, so the run observes an undelivered frame.
      "relay refuses the data lane",
      {
        refuseRelay: (ctx) =>
          ctx.lane === "data"
            ? { kind: "error", code: "relay_quota_exceeded", message: "retry_after_ms=1" }
            : null,
      },
      "relay_timeout",
    ],
    [
      "relay refuses the echo after delivering data (error surfaces on the next read)",
      {
        refuseRelay: (ctx) =>
          ctx.step === "data-echo"
            ? { kind: "error", code: "rate_limited", message: "too many frames" }
            : null,
      },
      "relay_timeout",
    ],
    ["no pong", { noPong: true }, "relay_timeout"],
    ["socket closed during data echo", { closeOnStep: "data-echo" }, "ws_closed"],
  ])("%s", async (_label, options, reason) => {
    const { checks } = await protocolOnly(options)
    expect(checks.signalingAuth).toMatchObject({ result: "pass", reason: null })
    expect(checks.relayData).toMatchObject({
      result: "fail",
      reason,
      attempted: true,
      dependsOn: null,
    })
  })
})

describe("phase isolation", () => {
  it("skips a stale earlier-phase frame and still verifies the real one", async () => {
    let staleSignal: Record<string, unknown> | null = null
    const { relay, checks } = await protocolOnly({
      onRelay: (frame, ctx) => {
        if (ctx.step === "signal") staleSignal = frame
        // Replay the old signal frame ahead of the data frame.
        if (ctx.step === "data" && staleSignal) return [staleSignal, frame]
        return frame
      },
    })
    expect(checks.relayData?.result).toBe("pass")
    expect(relay.sockets.every((socket) => socket.isClosed)).toBe(true)
  })

  it("never accepts a stale frame in place of a missing one", async () => {
    let staleSignal: Record<string, unknown> | null = null
    const { checks } = await protocolOnly({
      onRelay: (frame, ctx) => {
        if (ctx.step === "signal") staleSignal = frame
        // The real data frame is lost; only the stale signal arrives.
        if (ctx.step === "data") return staleSignal
        return frame
      },
    })
    expect(checks.relayData).toMatchObject({ result: "fail", reason: "relay_timeout" })
  })

  it("ignores frames from another session even with the right nonce", async () => {
    const { checks } = await protocolOnly({
      onRelay: (frame, ctx) =>
        ctx.step === "signal" ? [{ ...frame, fromSessionId: "intruder" }] : frame,
    })
    expect(checks.signalingAuth).toMatchObject({ result: "fail", reason: "relay_timeout" })
  })
})

describe("deadlines, cancellation and runner errors", () => {
  it("enforces the overall protocol deadline even with generous phases", async () => {
    const started = Date.now()
    const { checks } = await protocolOnly(
      { silentSubscribe: true },
      { limits: { phaseTimeoutMs: 10_000, protocolDeadlineMs: 400 } }
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(checks.signalingAuth).toMatchObject({ result: "fail", reason: "auth_timeout" })
  })

  it("times out a hanging upgrade and closes the socket that opens late", async () => {
    const relay = new FakeRelay({ hangOpen: true })
    const result = await run(relay, { runHttp: false })
    expect(byId(result.checks).signalingAuth).toMatchObject({ result: "fail", reason: "timeout" })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(relay.lateOpenedSocket?.closeCalls).toBe(1)
  })

  it("aborts promptly, reports unknown, and still closes sockets", async () => {
    const relay = new FakeRelay({ silentSubscribe: true })
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 50)
    const result = await run(relay, {
      signal: controller.signal,
      limits: { phaseTimeoutMs: 10_000, protocolDeadlineMs: 20_000 },
    })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result.aborted).toBe(true)
    const checks = byId(result.checks)
    expect(checks.signalingAuth).toMatchObject({ result: "unknown", reason: "runner_error" })
    expect(checks.relayData).toMatchObject({ result: "unknown", reason: "runner_error" })
    expect(relay.sockets.every((socket) => socket.isClosed)).toBe(true)
  })

  it("bounds cleanup when a socket never finishes closing", async () => {
    const relay = new FakeRelay({ closeNeverCompletes: true })
    const started = Date.now()
    const result = await run(relay, { runHttp: false, limits: { closeDeadlineMs: 150 } })
    expect(byId(result.checks).relayData?.result).toBe("pass")
    expect(relay.sockets.every((socket) => socket.closeCalls === 1)).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("reports an unexpected transport exception as runner_error, never a target failure", async () => {
    const relay = new FakeRelay({ upgradeError: () => new TypeError("adapter bug") })
    const checks = byId((await run(relay)).checks)
    expect(checks.signalingAuth).toMatchObject({ result: "unknown", reason: "runner_error" })
    expect(checks.relayData).toMatchObject({
      result: "unknown",
      reason: "runner_error",
      attempted: false,
    })
    expect(checks.signalingHttp?.result).toBe("pass")
  })

  it("treats an invalid limit as a runner error for every requested check", async () => {
    const result = await run(new FakeRelay(), { limits: { dataPayloadBytes: 10 * 1024 * 1024 } })
    expect(result.checks).toHaveLength(3)
    for (const check of result.checks) {
      expect(check).toMatchObject({ result: "unknown", reason: "runner_error", attempted: false })
    }
    expectBatchValid(result)
  })

  it("treats a non-WebSocket signaling URL as a runner error", async () => {
    const result = await runProbeChecks({
      signalingUrl: "https://signaling.example.test/signaling",
      profile: { id: "native", origin: null },
      runHttp: false,
      runProtocol: true,
      transport: new FakeRelay(),
      limits: FAST,
    })
    expect(byId(result.checks).signalingAuth).toMatchObject({
      result: "unknown",
      reason: "runner_error",
    })
  })
})

describe("relay byte budget", () => {
  it("refuses a payload that would reach the room budget", () => {
    const budget = new RelayBudget(100)
    budget.charge("x".repeat(60))
    expect(() => budget.charge("x".repeat(40))).toThrow(/budget/)
    expect(budget.sent).toBe(60)
  })
})

describe("signalingHttp", () => {
  const healthy = {
    backend: "worker",
    capabilities: { lanes: ["signal", "data"], protocol: 2, relayDataLane: true },
    ok: true,
    version: "0.1.0",
  }

  async function http(health: FakeRelayOptions["health"], limits: Partial<ProbeLimits> = {}) {
    const result = await run(new FakeRelay({ health }), { runProtocol: false, limits })
    return result.checks[0]
  }

  it("passes a ready relay with the expected protocol", async () => {
    expect(
      await http(async () => ({ status: 200, body: healthy, parseError: false }))
    ).toMatchObject({
      result: "pass",
      reason: null,
    })
  })

  it.each<[string, FakeRelayOptions["health"], string]>([
    ["non-200", async () => ({ status: 503, body: healthy, parseError: false }), "http_status"],
    [
      "not JSON",
      async () => ({ status: 200, body: undefined, parseError: true }),
      "schema_mismatch",
    ],
    [
      "empty body",
      async () => ({ status: 200, body: undefined, parseError: false }),
      "schema_mismatch",
    ],
    [
      "not a relay",
      async () => ({ status: 200, body: { ok: true }, parseError: false }),
      "schema_mismatch",
    ],
    [
      "no data lane",
      async () => ({
        status: 200,
        body: {
          ...healthy,
          capabilities: { lanes: ["signal"], protocol: 2, relayDataLane: false },
        },
        parseError: false,
      }),
      "schema_mismatch",
    ],
    [
      "wrong protocol",
      async () => ({
        status: 200,
        body: { ...healthy, capabilities: { ...healthy.capabilities, protocol: 3 } },
        parseError: false,
      }),
      "protocol_mismatch",
    ],
    [
      "transport timeout",
      async () => Promise.reject(new ProbeTransportError("timeout")),
      "timeout",
    ],
    ["DNS", async () => Promise.reject(new ProbeTransportError("dns_error")), "dns_error"],
    ["TLS", async () => Promise.reject(new ProbeTransportError("tls_error")), "tls_error"],
    [
      "connect",
      async () => Promise.reject(new ProbeTransportError("connect_error")),
      "connect_error",
    ],
  ])("fails on %s", async (_label, health, reason) => {
    expect(await http(health)).toMatchObject({ result: "fail", reason, attempted: true })
  })

  it("enforces its own deadline when the adapter hangs", async () => {
    const started = Date.now()
    const check = await http(() => new Promise(() => undefined), { httpTimeoutMs: 100 })
    expect(check).toMatchObject({ result: "fail", reason: "timeout" })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("reports an adapter bug as runner_error", async () => {
    expect(await http(async () => Promise.reject(new Error("boom")))).toMatchObject({
      result: "unknown",
      reason: "runner_error",
    })
  })
})
