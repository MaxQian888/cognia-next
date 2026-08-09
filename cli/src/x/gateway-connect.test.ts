/**
 * Unit tests for `cli/src/x/gateway-connect.ts`.
 */

import { connectGateway, probeDesktopGateway, DEFAULT_GATEWAY_PORT } from "./gateway-connect"

describe("probeDesktopGateway", () => {
  it("returns running=false when no server is listening", async () => {
    // Use a port that is almost certainly not in use
    const result = await probeDesktopGateway(19999)
    expect(result.running).toBe(false)
  })
})

describe("connectGateway", () => {
  it("uses desktop gateway when probe reports running", async () => {
    const conn = await connectGateway(
      { anthropicApiKey: "sk-ant-test" },
      {
        probe: async () => ({ running: true, port: DEFAULT_GATEWAY_PORT }),
        gatewayApiKey: "gw-key-123",
      }
    )
    expect(conn.mode).toBe("desktop-gateway")
    expect(conn.baseUrl).toContain(String(DEFAULT_GATEWAY_PORT))
    expect(conn.apiKey).toBe("gw-key-123")
    await conn.shutdown() // noop for desktop gateway
  })

  it("uses upstream API key as gateway key when no explicit gateway key", async () => {
    const conn = await connectGateway(
      { anthropicApiKey: "sk-ant-fallback" },
      {
        probe: async () => ({ running: true, port: 47823 }),
      }
    )
    expect(conn.mode).toBe("desktop-gateway")
    expect(conn.apiKey).toBe("sk-ant-fallback")
    await conn.shutdown()
  })

  it("falls back to node proxy when gateway is not running", async () => {
    let proxyStarted = false
    const conn = await connectGateway(
      { anthropicApiKey: "sk-ant-real" },
      {
        probe: async () => ({ running: false }),
        startProxy: async () => {
          proxyStarted = true
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
    expect(conn.mode).toBe("node-proxy")
    expect(conn.baseUrl).toBe("http://127.0.0.1:12345")
    expect(conn.apiKey).toBe("cgx-test")
    await conn.shutdown()
  })

  it("respects custom gateway port", async () => {
    let probedPort: number | undefined
    const conn = await connectGateway(
      { anthropicApiKey: "k" },
      {
        gatewayPort: 55555,
        probe: async (port) => {
          probedPort = port
          return { running: true, port }
        },
        gatewayApiKey: "key",
      }
    )
    expect(probedPort).toBe(55555)
    expect(conn.baseUrl).toContain("55555")
    await conn.shutdown()
  })
})
