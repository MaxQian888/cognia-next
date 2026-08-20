import { decodePairPayload, encodePairPayload } from "@/lib/qr/pair-payload"
import {
  clearCompanionAccessTokens,
  CompanionApiError,
  companionErrorCode,
  devicePlatformLabel,
  issueSocketTicket,
  registerCompanionDevice,
  registerCompanionWorker,
  type AuthFetcher,
} from "./companion-auth"

function unsignedToken(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

describe("companion auth lifecycle", () => {
  afterEach(() => clearCompanionAccessTokens())

  it("keeps bearer credentials out of the pairing payload", () => {
    const encoded = encodePairPayload({
      baseUrl: "https://host.test",
      mode: "owner-invitation",
      invitation: "one-time",
      hostId: "host-a",
      tenantId: "tenant-a",
      expiresAt: Date.now() + 60_000,
      serverVersion: "1.0.0",
      fingerprint: "abc",
    })
    expect(encoded).not.toContain("Bearer")
    expect(decodePairPayload(encoded).kind).toBe("ok")
  })

  it("binds browser socket ticket requests to a session", async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "once", expiresIn: 60 }),
    })

    await issueSocketTicket(
      {
        baseUrl: "https://host.test",
        serviceToken: "service-token",
        deviceId: "device-a",
        serverVersion: "1.0.0",
      },
      { channel: "browser", sessionId: "session-a" },
      fetcher
    )

    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      channel: "browser",
      sessionId: "session-a",
    })
  })

  it("rejects an empty browser session before making a request", async () => {
    const fetcher = jest.fn()

    await expect(
      issueSocketTicket(
        {
          baseUrl: "https://host.test",
          serviceToken: "service-token",
          deviceId: "device-a",
          serverVersion: "1.0.0",
        },
        { channel: "browser", sessionId: " " },
        fetcher
      )
    ).rejects.toThrow("browser socket tickets require a sessionId")
    expect(fetcher).not.toHaveBeenCalled()
  })

  // Two refusals can share a status and a shape but need opposite remedies: a
  // missing capability wants a grant from an owner, a host-wide switch wants
  // the switch. Callers were left string-matching English server copy to tell
  // them apart — `lib/terminal/host-state.ts` classifies on the code instead.
  it("carries the refusal code alongside the message", async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: "terminal_remote_access_disabled",
          message: "remote terminal access is disabled on this host",
        },
      }),
    })

    const error = await issueSocketTicket(
      {
        baseUrl: "https://host.test",
        serviceToken: "service-token",
        deviceId: "device-a",
        serverVersion: "1.0.0",
      },
      "terminal",
      fetcher
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CompanionApiError)
    expect(companionErrorCode(error)).toBe("terminal_remote_access_disabled")
    expect((error as Error).message).toBe("remote terminal access is disabled on this host")
    expect((error as CompanionApiError).status).toBe(403)
  })

  it("reports no code when the host did not send one", async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => null,
    })

    const error = await issueSocketTicket(
      {
        baseUrl: "https://host.test",
        serviceToken: "service-token",
        deviceId: "device-a",
        serverVersion: "1.0.0",
      },
      "terminal",
      fetcher
    ).catch((caught: unknown) => caught)

    expect(companionErrorCode(error)).toBe("")
    expect((error as Error).message).toBe("HTTP 500")
  })

  it("requests the dedicated worker socket channel without path credentials", async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "worker-once", expiresIn: 60 }),
    })

    await issueSocketTicket(
      {
        baseUrl: "https://host.test",
        serviceToken: "service-token",
        deviceId: "worker-a",
        serverVersion: "1.0.0",
      },
      "worker",
      fetcher
    )

    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ channel: "worker" })
    expect(fetcher.mock.calls[0][0]).toBe("https://host.test/api/auth/socket-ticket")
  })

  it("registers independent auth and signaling identities from canonical config", async () => {
    const hostId = "host-a"
    const tenantId = "local_acct_a"
    let challenge = 0
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      if (path === "/api/auth/config") {
        return Response.json({
          deploymentMode: "single-user",
          hostId,
          tenantId,
          signaling: {
            url: "wss://host.test/signaling",
            iceServers: [{ urls: ["stun:stun.example:3478"] }],
          },
        })
      }
      if (path === "/api/auth/device/challenge") {
        challenge += 1
        return Response.json({
          challengeId: `challenge-${challenge}`,
          nonce: `nonce-${challenge}`,
          expiresAt: Date.now() + 60_000,
        })
      }
      if (path === "/api/auth/device/register") {
        const body = JSON.parse(init.body as string)
        expect(body.publicKeyPem).toContain("BEGIN PUBLIC KEY")
        expect(body.signalingPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
        expect(body.publicKeyPem).not.toContain(body.signalingPublicKey)
        // ADR-0127: self-reported labels for the host's device-paired event
        // (this suite runs in the node env — no window ⇒ "unknown").
        expect(body.platform).toBe("unknown")
        expect(typeof body.appVersion).toBe("string")
        expect(body.appVersion.length).toBeGreaterThan(0)
        return Response.json({
          deviceId: body.deviceId,
          tenantId,
          role: "owner",
          serverVersion: "2.0.0",
          signaling: {
            rendezvousId: "room-a",
            roomDescriptor: {
              v: 2,
              roomId: "room-a",
              roomNonce: "nonce",
              desktopSigningKey: "desktop",
              mobileSigningKey: body.signalingPublicKey,
              notAfter: Date.now() + 60_000,
            },
          },
        })
      }
      if (path === "/api/auth/token") {
        const payload = Buffer.from(JSON.stringify({ jti: "access-jti" })).toString("base64url")
        return Response.json({ accessToken: `header.${payload}.signature`, expiresIn: 300 })
      }
      throw new Error(`unexpected request ${path}`)
    }) as unknown as AuthFetcher

    const config = await registerCompanionDevice(
      {
        baseUrl: "https://host.test",
        mode: "owner-invitation",
        invitation: "one-time",
        hostId,
        tenantId,
        displayName: "Browser",
        serverVersion: "1.0.0",
      },
      fetcher
    )

    expect(config).toMatchObject({
      deviceId: expect.any(String),
      tenantId,
      serverVersion: "2.0.0",
      rendezvousId: "room-a",
      signalingUrl: "wss://host.test/signaling",
      iceServers: [{ urls: ["stun:stun.example:3478"] }],
      signalingPrivateKeyJwk: expect.objectContaining({ d: expect.any(String) }),
    })
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it("registers worker enrollment with only the dedicated worker capability", async () => {
    let challenge = 0
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      if (path === "/api/auth/device/challenge") {
        challenge += 1
        return Response.json({
          challengeId: `challenge-${challenge}`,
          nonce: `nonce-${challenge}`,
          expiresAt: Date.now() + 60_000,
        })
      }
      if (path === "/api/auth/worker/register") {
        const body = JSON.parse(init.body as string)
        expect(body.enrollment).toBe("one-time-worker")
        return Response.json({
          deviceId: body.deviceId,
          tenantId: "tenant-a",
          role: "member",
          capabilities: ["agent.worker"],
          serverVersion: "1.0.0",
        })
      }
      if (path === "/api/auth/token") {
        return Response.json({
          accessToken: unsignedToken({ jti: "worker-token" }),
          expiresIn: 300,
        })
      }
      throw new Error(`unexpected ${path}`)
    })

    const registered = await registerCompanionWorker(
      {
        baseUrl: "https://host.test",
        tenantId: "tenant-a",
        enrollment: "one-time-worker",
        displayName: "Worker A",
      },
      fetcher
    )

    expect(registered).toMatchObject({ tenantId: "tenant-a", serverVersion: "1.0.0" })
    expect(registered.devicePrivateKeyJwk).toBeDefined()
  })

  it("rejects a Host mismatch before generating or registering a device", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      Response.json({
        deploymentMode: "single-user",
        hostId: "other-host",
        tenantId: "tenant-a",
        signaling: { url: "wss://host.test/signaling", iceServers: [] },
      })
    ) as unknown as AuthFetcher

    await expect(
      registerCompanionDevice(
        {
          baseUrl: "https://host.test",
          mode: "owner-invitation",
          invitation: "one-time",
          hostId: "expected-host",
          tenantId: "tenant-a",
          displayName: "Browser",
          serverVersion: "1.0.0",
        },
        fetcher
      )
    ).rejects.toThrow("pairing payload Host does not match server")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["issuer", { issuer: "https://wrong-id.test/oidc" }],
    ["resource", { resource: "https://wrong-api.test" }],
    ["client", { clientId: "wrong-web-client" }],
  ])("rejects an OIDC %s mismatch before device registration", async (_label, mismatch) => {
    const fetcher = jest.fn().mockResolvedValue(
      Response.json({
        deploymentMode: "multi-tenant",
        hostId: "host-a",
        oidc: {
          issuer: "https://id.test/oidc",
          audience: "https://api.test",
          webClientId: "web-client",
          scopes: ["openid", "brain:rpc"],
        },
        signaling: { url: "wss://host.test/signaling", iceServers: [] },
      })
    ) as unknown as AuthFetcher

    await expect(
      registerCompanionDevice(
        {
          baseUrl: "https://host.test",
          mode: "oidc",
          hostId: "host-a",
          tenantId: "tenant-a",
          displayName: "Browser",
          serverVersion: "1.0.0",
          oidc: {
            issuer: "https://id.test/oidc",
            resource: "https://api.test",
            clientId: "web-client",
            organizationId: "tenant-a",
            accessToken: "oidc-access",
            ...mismatch,
          },
        },
        fetcher
      )
    ).rejects.toThrow("OIDC session issuer, resource, or client does not match server config")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("rejects an OIDC organization mismatch before device registration", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      Response.json({
        deploymentMode: "multi-tenant",
        hostId: "host-a",
        oidc: {
          issuer: "https://id.test/oidc",
          audience: "https://api.test",
          webClientId: "web-client",
          scopes: ["openid", "brain:rpc"],
        },
        signaling: { url: "wss://host.test/signaling", iceServers: [] },
      })
    ) as unknown as AuthFetcher

    await expect(
      registerCompanionDevice(
        {
          baseUrl: "https://host.test",
          mode: "oidc",
          hostId: "host-a",
          tenantId: "tenant-a",
          displayName: "Browser",
          serverVersion: "1.0.0",
          oidc: {
            issuer: "https://id.test/oidc",
            resource: "https://api.test",
            clientId: "web-client",
            organizationId: "tenant-b",
            accessToken: "oidc-access",
          },
        },
        fetcher
      )
    ).rejects.toThrow("OIDC organization does not match pairing tenant")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe("devicePlatformLabel (ADR-0127)", () => {
  const g = globalThis as { window?: unknown }
  afterEach(() => {
    delete g.window
  })

  it("is unknown without a window (node / headless)", () => {
    expect(devicePlatformLabel()).toBe("unknown")
  })

  it("reports the Capacitor native platform, web for a browser, unknown for a Tauri desktop", () => {
    g.window = {}
    expect(devicePlatformLabel()).toBe("web")
    g.window = { Capacitor: { getPlatform: () => "ios" } }
    expect(devicePlatformLabel()).toBe("ios")
    g.window = { Capacitor: { getPlatform: () => "android" } }
    expect(devicePlatformLabel()).toBe("android")
    g.window = { Capacitor: { getPlatform: () => "web" } }
    expect(devicePlatformLabel()).toBe("web")
    g.window = { __TAURI_INTERNALS__: {} }
    expect(devicePlatformLabel()).toBe("unknown")
  })
})
