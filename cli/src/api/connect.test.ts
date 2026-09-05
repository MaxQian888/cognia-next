import { connectHost, connectResolvedHost } from "./connect"
import type { HostResolution, ResolvedHost } from "../host/resolve"

const ENDPOINT = "https://127.0.0.1:27890"

/**
 * A real P-256 key, because `signerFromJwk` imports it through WebCrypto and
 * a placeholder object fails there rather than in anything under test.
 */
let privateKeyJwk: JsonWebKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
  privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
})

function headlessHost(overrides: Partial<ResolvedHost> = {}): ResolvedHost {
  return {
    name: "local",
    kind: { value: "headless", source: "user-file" },
    endpoint: { value: ENDPOINT, source: "user-file" },
    serviceToken: { value: "svc", source: "env", origin: "COGNIA_SERVICE_TOKEN" },
    ...overrides,
  }
}

function deviceHost(overrides: Partial<ResolvedHost> = {}): ResolvedHost {
  return {
    name: "prod",
    kind: { value: "device", source: "user-file" },
    endpoint: { value: ENDPOINT, source: "user-file" },
    tenantId: { value: "tnt_1", source: "user-file" },
    record: {
      kind: "device",
      endpoint: ENDPOINT,
      deviceId: "dev_1",
      devicePrivateKeyJwk: privateKeyJwk as unknown as Record<string, unknown>,
    },
    ...overrides,
  }
}

describe("connectHost with nothing resolved", () => {
  const empty: HostResolution = {
    skipped: [{ leg: "environment", reason: "COGNIA_SERVER_URL is not set" }],
  }

  it("tells the operator how to add a host when no desktop is running", async () => {
    const result = await connectHost(empty, { detect: async () => null })
    expect(result.ok).toBe(false)
    const failure = (result as { failure: { fix: string[]; cause: string; details: string[] } })
      .failure
    expect(failure.cause).toBe("no-host")
    expect(failure.fix[0]).toContain("host add")
    expect(failure.details[0]).toContain("COGNIA_SERVER_URL is not set")
  })

  it("points at pairing when a desktop is running on this machine", async () => {
    const result = await connectHost(empty, {
      detect: async () => ({ baseUrl: "http://127.0.0.1:5599" }),
    })
    const fix = (result as { failure: { fix: string[] } }).failure.fix.join(" ")
    // The desktop's CLI bridge carries 18 routes and dispatching commands is
    // not one of them, so the advice must be to pair with the Companion API,
    // never to point the CLI at the bridge URL.
    expect(fix).toContain("host login desktop")
    expect(fix).toContain("--pair-code")
    expect(fix).not.toContain("127.0.0.1:5599")
  })

  it("does not offer a flag the CLI has no implementation for", async () => {
    const result = await connectHost(empty, {
      detect: async () => ({ baseUrl: "http://127.0.0.1:5599" }),
    })
    expect((result as { failure: { fix: string[] } }).failure.fix.join(" ")).not.toContain(
      "--enroll"
    )
  })

  it("survives a desktop probe that throws", async () => {
    const result = await connectHost(empty, {
      detect: async () => {
        throw new Error("socket closed")
      },
    })
    expect((result as { failure: { fix: string[] } }).failure.fix[0]).toContain("host add")
  })
})

describe("connectResolvedHost", () => {
  it("builds a headless transport from a service token", async () => {
    const result = await connectResolvedHost(headlessHost())
    expect(result.ok).toBe(true)
    expect((result as { transport: { wire: string; label: string } }).transport.wire).toBe(
      "internal"
    )
    expect((result as { transport: { label: string } }).transport.label).toContain(ENDPOINT)
  })

  it("refuses a headless host with no token and names where the endpoint came from", async () => {
    const result = await connectResolvedHost(
      headlessHost({
        serviceToken: undefined,
        endpoint: { value: ENDPOINT, source: "env", origin: "COGNIA_SERVER_URL" },
      })
    )
    const failure = (result as { failure: { cause: string; fix: string[]; details: string[] } })
      .failure
    expect(failure.cause).toBe("auth")
    expect(failure.details[0]).toContain("COGNIA_SERVER_URL")
    expect(failure.fix[0]).toContain("COGNIA_SERVICE_TOKEN")
  })

  it("builds a device transport from a stored identity", async () => {
    const result = await connectResolvedHost(deviceHost())
    expect(result.ok).toBe(true)
    const transport = (result as { transport: { wire: string; label: string } }).transport
    expect(transport.wire).toBe("http")
    expect(transport.label).toContain("dev_1")
  })

  it("sends the operator to login when a device host has no identity", async () => {
    const result = await connectResolvedHost(deviceHost({ record: undefined }))
    const failure = (result as { failure: { cause: string; fix: string[] } }).failure
    expect(failure.cause).toBe("auth")
    expect(failure.fix[0]).toContain("host login --profile prod")
  })

  it("refuses a device host with no tenant id, which the token exchange needs", async () => {
    const result = await connectResolvedHost(deviceHost({ tenantId: undefined }))
    const failure = (result as { failure: { cause: string; fix: string[] } }).failure
    expect(failure.cause).toBe("auth")
    expect(failure.fix[0]).toContain("--tenant")
  })
})
