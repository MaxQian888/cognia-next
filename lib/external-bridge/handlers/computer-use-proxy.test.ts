/** @jest-environment node */
import * as net from "node:net"
import type { AppLocator } from "@/lib/automation/types"
import { __testing__, computerUse } from "./computer-use-proxy"
const locator: AppLocator = { kind: "bundleId", bundleId: "com.apple.TextEdit" }

describe("computerUse canonical sidecar adapter", () => {
  let server: net.Server
  let port: number
  const seen: Record<string, unknown>[] = []

  beforeAll(async () => {
    server = net.createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const request = JSON.parse(line) as Record<string, unknown>
          seen.push(request)
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: { revision: 4 },
            })}\n`
          )
          newline = buffer.indexOf("\n")
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as net.AddressInfo).port
  })

  afterAll(async () => {
    __testing__.resetProxyClient()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    seen.length = 0
    process.env.COGNIA_AUTOMATION_PROXY = `127.0.0.1:${port}`
    process.env.COGNIA_AUTOMATION_PROXY_TOKEN = "secret"
  })

  afterEach(() => {
    __testing__.resetProxyClient()
    delete process.env.COGNIA_AUTOMATION_PROXY
    delete process.env.COGNIA_AUTOMATION_PROXY_TOKEN
  })

  it("uses only the canonical get-app-state wire command", async () => {
    const result = await computerUse({
      operation: "getAppState",
      sessionId: "app-session",
      turnKey: "message-2",
      locator,
    })

    expect(result).toEqual({ ok: true, result: { revision: 4 } })
    expect(seen[0]).toMatchObject({
      token: "secret",
      command: "desktop_get_app_state",
      args: {
        sessionId: "app-session",
        turnKey: "message-2",
        locator,
        options: {},
      },
    })
  })

  it("uses the canonical zoom wire command", async () => {
    const region = { x: 4, y: 8, width: 64, height: 48 }
    await computerUse({
      operation: "zoom",
      sessionId: "app-session",
      lineageId: "lineage",
      revision: 4,
      region,
    })

    expect(seen[0]).toMatchObject({
      token: "secret",
      command: "desktop_zoom",
      args: { sessionId: "app-session", lineageId: "lineage", revision: 4, region },
    })
  })

  it("reports a missing desktop runtime without opening a socket", async () => {
    delete process.env.COGNIA_AUTOMATION_PROXY
    const result = await computerUse({ operation: "listApps" })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Cognia desktop runtime/)
  })
})
