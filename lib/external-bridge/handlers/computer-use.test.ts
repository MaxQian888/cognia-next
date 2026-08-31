jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    listApps: jest.fn(),
    getAppState: jest.fn(),
    queryElements: jest.fn(),
    expandElement: jest.fn(),
    performAction: jest.fn(),
    zoom: jest.fn(),
  },
}))

import * as net from "node:net"
import { desktop } from "@/lib/automation/client"
import { isTauri } from "@/lib/tauri"
import type { ActionRequest, AppLocator } from "@/lib/automation/types"
import { __testing__, computerUse } from "./computer-use"

const mockedIsTauri = isTauri as jest.Mock
const mockedDesktop = desktop as jest.Mocked<typeof desktop>
const locator: AppLocator = {
  kind: "bundleId",
  bundleId: "com.apple.TextEdit",
}

beforeEach(() => {
  jest.clearAllMocks()
  __testing__.resetProxyClient()
})

describe("computerUse canonical renderer adapter", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(true))

  it("reads a screenshot-bound app revision with an authenticated turn key", async () => {
    mockedDesktop.getAppState.mockResolvedValueOnce({ revision: 3 } as never)
    const result = await computerUse({
      operation: "getAppState",
      sessionId: "app-session",
      turnKey: "message-1",
      locator,
    })

    expect(result).toEqual({ ok: true, result: { revision: 3 } })
    expect(mockedDesktop.getAppState).toHaveBeenCalledWith("app-session", locator, undefined, {
      surface: "mcp",
      turnKey: "message-1",
    })
  })

  it("forwards a canonical action request without translation", async () => {
    const request = {
      turnToken: "token",
      target: {
        kind: "pixel",
        target: {
          sessionId: "app-session",
          lineageId: "lineage",
          revision: 3,
          point: { x: 10, y: 20 },
          screenshotWidth: 100,
          screenshotHeight: 80,
        },
      },
      action: { kind: "click" },
      strategy: "pixel",
    } satisfies ActionRequest
    mockedDesktop.performAction.mockResolvedValueOnce({ status: "unknown" } as never)

    await computerUse({
      operation: "performAction",
      turnKey: "message-1",
      request,
    })

    expect(mockedDesktop.performAction).toHaveBeenCalledWith(request, {
      surface: "mcp",
      turnKey: "message-1",
    })
  })

  it("crops a region of the revision the caller already read", async () => {
    mockedDesktop.zoom.mockResolvedValueOnce({ revision: 3 } as never)
    const region = { x: 100, y: 200, width: 320, height: 240 }
    const result = await computerUse({
      operation: "zoom",
      sessionId: "app-session",
      lineageId: "lineage",
      revision: 3,
      region,
    })

    expect(result).toEqual({ ok: true, result: { revision: 3 } })
    // A zoom re-reads pixels the caller was already shown, so it carries no
    // turn key: there is no mutation to bind and no token to burn.
    expect(mockedDesktop.zoom).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "app-session", lineageId: "lineage", revision: 3 }),
      region,
      { surface: "mcp", turnKey: undefined }
    )
  })

  it("fails closed when a mutation has no authenticated turn key", async () => {
    const result = await computerUse({
      operation: "performAction",
      turnKey: "",
      request: {} as ActionRequest,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/turnKey/)
    expect(mockedDesktop.performAction).not.toHaveBeenCalled()
  })
})

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
    mockedIsTauri.mockReturnValue(false)
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
