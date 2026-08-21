/**
 * @jest-environment jsdom
 */

import {
  DEFAULT_BROWSER_ACCESS_PORT,
  discoverLoopbackHost,
  type LoopbackProbeOutcome,
} from "./loopback-discovery"
import type { HealthzResult } from "./healthz"

const HEALTH: HealthzResult = {
  version: "1.2.3",
  fingerprint: "sha256-abc",
  advertisedPort: 27890,
  serverId: "install-1",
}

function neverListening(): typeof fetch {
  return jest.fn(async () => {
    throw new TypeError("Failed to fetch")
  }) as unknown as typeof fetch
}

function alwaysAnswers(): typeof fetch {
  // In a real browser `no-cors` yields an *opaque* response — unreadable body,
  // status 0 — which is exactly why it can only answer "someone is there",
  // never "and they said yes". This environment cannot mint one (`new
  // Response(null, …)` throws here), and it does not need to: the contract
  // under test is only "the fetch resolved rather than rejecting".
  return jest.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch
}

function run(overrides: Partial<Parameters<typeof discoverLoopbackHost>[0]> = {}) {
  return discoverLoopbackHost({
    signal: new AbortController().signal,
    healthzFetcher: jest.fn(async () => null),
    fetchImpl: neverListening(),
    origin: "http://localhost:3000",
    ...overrides,
  })
}

describe("discoverLoopbackHost", () => {
  it("defaults to the Rust browser-access port", () => {
    // Mirrors `browser_access::DEFAULT_BROWSER_PORT`; drifting apart would
    // make the browser probe a port nothing serves.
    expect(DEFAULT_BROWSER_ACCESS_PORT).toBe(27891)
  })

  it("reports a readable Host as found, with its health payload", async () => {
    const healthzFetcher = jest.fn(async () => HEALTH)

    await expect(run({ healthzFetcher })).resolves.toEqual<LoopbackProbeOutcome>({
      kind: "found",
      baseUrl: "http://127.0.0.1:27891",
      health: HEALTH,
    })
    expect(healthzFetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:27891",
      expect.objectContaining({ timeoutMs: 800 })
    )
  })

  it("honours a custom port", async () => {
    const healthzFetcher = jest.fn(async () => HEALTH)

    await expect(run({ healthzFetcher, port: 31337 })).resolves.toMatchObject({
      baseUrl: "http://127.0.0.1:31337",
    })
  })

  it("falls through to `localhost` when `127.0.0.1` is unreadable", async () => {
    // The host matches allowed origins by exact string, so the two spellings
    // are genuinely two chances at the same Host.
    const healthzFetcher = jest.fn(async (baseUrl: string) =>
      baseUrl.includes("localhost") ? HEALTH : null
    )

    await expect(run({ healthzFetcher })).resolves.toMatchObject({
      kind: "found",
      baseUrl: "http://localhost:27891",
    })
  })

  it("reports `blocked` — not `absent` — when a Host answers but refuses this origin", async () => {
    // The 403 arrives without CORS headers, so `fetch` rejects exactly as it
    // does for a closed port. Calling that "no hosts found" would state an
    // absence we never verified.
    await expect(
      run({ healthzFetcher: jest.fn(async () => null), fetchImpl: alwaysAnswers() })
    ).resolves.toEqual<LoopbackProbeOutcome>({
      kind: "blocked",
      baseUrl: "http://127.0.0.1:27891",
      origin: "http://localhost:3000",
    })
  })

  it("names this tab's own origin so the user can allowlist it verbatim", async () => {
    const outcome = await run({
      healthzFetcher: jest.fn(async () => null),
      fetchImpl: alwaysAnswers(),
      origin: "https://app.example.test",
    })

    expect(outcome).toMatchObject({ origin: "https://app.example.test" })
  })

  it("probes without credentials", async () => {
    // The port may not be ours; a probe must never carry cookies to it.
    const fetchImpl = alwaysAnswers()

    await run({ healthzFetcher: jest.fn(async () => null), fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:27891/healthz",
      expect.objectContaining({ mode: "no-cors", credentials: "omit" })
    )
  })

  it("reports absent when nothing answers on either spelling", async () => {
    const fetchImpl = neverListening()

    await expect(
      run({ healthzFetcher: jest.fn(async () => null), fetchImpl })
    ).resolves.toEqual<LoopbackProbeOutcome>({ kind: "absent" })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("stops immediately when the caller aborts", async () => {
    const controller = new AbortController()
    controller.abort()
    const healthzFetcher = jest.fn(async () => HEALTH)

    await expect(run({ signal: controller.signal, healthzFetcher })).resolves.toEqual({
      kind: "absent",
    })
    expect(healthzFetcher).not.toHaveBeenCalled()
  })

  it("survives an environment with no fetch at all", async () => {
    await expect(
      run({ healthzFetcher: jest.fn(async () => null), fetchImpl: undefined })
    ).resolves.toEqual({ kind: "absent" })
  })
})
