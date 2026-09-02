/**
 * Unit tests for `cli/src/x/gateway-connect.ts`.
 */

import {
  DEFAULT_GATEWAY_PORT,
  GatewayCredentialError,
  RemoteGatewayRefusedError,
  connectGateway,
  isLoopbackUrl,
  probeDesktopGateway,
  resolveGatewayUrl,
} from "./gateway-connect"

const ticketRequest = {
  model: "claude-opus-5",
  sessionId: "s",
  executionFingerprint: "f",
  routePolicy: "gateway-required",
}

describe("probeDesktopGateway", () => {
  it("returns running=false when no server is listening", async () => {
    const result = await probeDesktopGateway("http://127.0.0.1:19999")
    expect(result.running).toBe(false)
  })
})

describe("resolveGatewayUrl", () => {
  it("prefers an explicit url, then COGNIA_GATEWAY_URL, then the port", () => {
    expect(resolveGatewayUrl({ gatewayUrl: "http://127.0.0.1:1/", env: {} })).toBe(
      "http://127.0.0.1:1"
    )
    expect(resolveGatewayUrl({ env: { COGNIA_GATEWAY_URL: "http://localhost:2" } })).toBe(
      "http://localhost:2"
    )
    expect(resolveGatewayUrl({ env: { COGNIA_GATEWAY_PORT: "3" } })).toBe("http://127.0.0.1:3")
    expect(resolveGatewayUrl({ env: {} })).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`)
    expect(isLoopbackUrl("http://[::1]:5")).toBe(true)
    expect(isLoopbackUrl("http://10.0.0.5:5")).toBe(false)
  })
})

describe("connectGateway", () => {
  it("uses an explicit gateway key when the gateway is running", async () => {
    const conn = await connectGateway(
      { anthropicApiKey: "sk-ant-test" },
      {
        env: {},
        probe: async (baseUrl) => ({ running: true, baseUrl }),
        gatewayApiKey: "gw-key-123",
      }
    )
    expect(conn.mode).toBe("desktop-gateway-key")
    expect(conn.baseUrl).toContain(String(DEFAULT_GATEWAY_PORT))
    expect(conn.apiKey).toBe("gw-key-123")
    await conn.shutdown()
  })

  it("mints a route ticket when no explicit key is set", async () => {
    let minted: unknown
    const conn = await connectGateway(
      { anthropicApiKey: "sk-ant-real" },
      {
        env: {},
        probe: async (baseUrl) => ({ running: true, baseUrl }),
        ticketRequest,
        mintTicket: async (request) => {
          minted = request
          return {
            outcome: {
              ok: true,
              via: "bridge",
              ticket: {
                endpoint: "http://127.0.0.1:47823/v1",
                ticketId: "rt_1",
                secret: "sk-cognia-rt-1",
                modelBindings: { haiku: "claude-haiku-4-5-20251001" },
                expiresAtMs: 1,
              },
            },
            attempts: [],
          }
        },
      }
    )
    expect(minted).toEqual(ticketRequest)
    expect(conn.mode).toBe("desktop-gateway-ticket")
    expect(conn.apiKey).toBe("sk-cognia-rt-1")
    expect(conn.modelBindings).toEqual({ haiku: "claude-haiku-4-5-20251001" })
    expect(conn.ticketId).toBe("rt_1")
  })

  it("never hands an upstream provider key to the gateway", async () => {
    await expect(
      connectGateway(
        { anthropicApiKey: "sk-ant-real", openaiApiKey: "sk-openai-real" },
        {
          env: {},
          probe: async (baseUrl) => ({ running: true, baseUrl }),
          ticketRequest,
          mintTicket: async () => ({
            outcome: { ok: false, via: "rpc", reason: "no-server", message: "no server" },
            attempts: [
              { ok: false, via: "bridge", reason: "no-desktop", message: "desktop not running" },
              { ok: false, via: "rpc", reason: "no-server", message: "no server" },
            ],
          }),
        }
      )
    ).rejects.toMatchObject({
      name: "GatewayCredentialError",
      message: expect.stringMatching(/desktop not running[\s\S]*COGNIA_GATEWAY_KEY/),
    })
    await expect(
      connectGateway(
        { anthropicApiKey: "sk-ant-real" },
        { env: {}, probe: async (baseUrl) => ({ running: true, baseUrl }) }
      )
    ).rejects.toBeInstanceOf(GatewayCredentialError)
  })

  it("refuses a remote gateway url unless allowed", async () => {
    const deps = {
      env: { COGNIA_GATEWAY_URL: "http://10.0.0.9:47823" },
      probe: async (baseUrl: string) => ({ running: true, baseUrl }),
      gatewayApiKey: "k",
    }
    await expect(connectGateway({}, deps)).rejects.toBeInstanceOf(RemoteGatewayRefusedError)
    const conn = await connectGateway({}, { ...deps, allowRemoteGateway: true })
    expect(conn.baseUrl).toBe("http://10.0.0.9:47823")
  })

  it("falls back to node proxy when gateway is not running, materializing keys only then", async () => {
    let proxyStarted = false
    let built = 0
    const conn = await connectGateway(
      () => {
        built += 1
        return { anthropicApiKey: "sk-ant-real" }
      },
      {
        env: {},
        probe: async () => ({ running: false }),
        startProxy: async (config) => {
          proxyStarted = true
          expect(config.anthropicApiKey).toBe("sk-ant-real")
          return {
            baseUrl: "http://127.0.0.1:12345",
            apiKey: "cgx-test",
            port: 12345,
            shutdown: async () => {},
          }
        },
      }
    )
    expect(proxyStarted).toBe(true)
    expect(built).toBe(1)
    expect(conn.mode).toBe("node-proxy")
    expect(conn.baseUrl).toBe("http://127.0.0.1:12345")
    expect(conn.apiKey).toBe("cgx-test")
    await conn.shutdown()
  })

  it("respects custom gateway port", async () => {
    let probed: string | undefined
    const conn = await connectGateway(
      { anthropicApiKey: "k" },
      {
        env: {},
        gatewayPort: 55555,
        probe: async (baseUrl) => {
          probed = baseUrl
          return { running: true, baseUrl }
        },
        gatewayApiKey: "key",
      }
    )
    expect(probed).toBe("http://127.0.0.1:55555")
    expect(conn.baseUrl).toContain("55555")
    await conn.shutdown()
  })
})
