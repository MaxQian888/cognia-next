/**
 * Tests for the External Bridge `computer_use` handler.
 *
 * Two code paths to cover:
 *   - **Renderer path** — `isTauri()` returns true. The handler calls
 *     `desktop.*` directly. The test mocks both modules.
 *   - **Sidecar path** — `isTauri()` returns false, and either
 *       (a) `COGNIA_AUTOMATION_PROXY` is unset → returns the
 *           "requires the Cognia desktop runtime" error envelope, or
 *       (b) the env is set → the handler opens a TCP socket and writes
 *           the JSON envelope. We boot a minimal echo server on a
 *           random localhost port for the round-trip.
 */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    screenshot: jest.fn(),
    click: jest.fn(),
    type: jest.fn(),
    keys: jest.fn(),
    mouseMove: jest.fn(),
    drag: jest.fn(),
    scroll: jest.fn(),
    holdKey: jest.fn(),
    mouseButton: jest.fn(),
    cursorPosition: jest.fn(),
  },
}))

import { isTauri } from "@/lib/tauri"
import { desktop } from "@/lib/automation/client"
import { computerUse, __testing__ } from "./computer-use"
import * as net from "node:net"

const mockedIsTauri = isTauri as jest.Mock
const mockedDesktop = desktop as jest.Mocked<typeof desktop>

beforeEach(() => {
  jest.clearAllMocks()
  __testing__.resetProxyClient()
})

describe("computerUse — renderer path", () => {
  beforeEach(() => {
    mockedIsTauri.mockReturnValue(true)
  })

  it("screenshot returns base64 + dimensions", async () => {
    mockedDesktop.screenshot.mockResolvedValueOnce({
      bytes: "AA==",
      width: 1280,
      height: 800,
      capturedAt: 0,
      format: "png",
    })
    const result = await computerUse({ action: "screenshot" })
    expect(result).toEqual({ ok: true, screenshot: "AA==", width: 1280, height: 800 })
    expect(mockedDesktop.screenshot).toHaveBeenCalledWith({}, { surface: "mcp" })
  })

  it("click forwards count for triple-click", async () => {
    mockedDesktop.click.mockResolvedValueOnce(undefined)
    await computerUse({
      action: "click",
      coordinate: [10, 20],
      button: "left",
      count: 3,
    })
    expect(mockedDesktop.click).toHaveBeenCalledWith(
      { kind: "point", x: 10, y: 20 },
      { button: "left", double: undefined, count: 3 },
      { surface: "mcp" }
    )
  })

  it("cursor_position returns the Point", async () => {
    mockedDesktop.cursorPosition.mockResolvedValueOnce({ x: 42, y: 99 })
    const result = await computerUse({ action: "cursor_position" })
    expect(result).toEqual({ ok: true, cursor: { x: 42, y: 99 } })
  })

  it("captures thrown errors", async () => {
    mockedDesktop.click.mockRejectedValueOnce(new Error("denied"))
    const result = await computerUse({
      action: "click",
      coordinate: [1, 2],
    })
    expect(result).toEqual({ ok: false, error: "denied" })
  })
})

describe("computerUse — sidecar path (no env)", () => {
  beforeEach(() => {
    mockedIsTauri.mockReturnValue(false)
    delete process.env.COGNIA_AUTOMATION_PROXY
    delete process.env.COGNIA_AUTOMATION_PROXY_TOKEN
  })

  it("returns the structured 'requires desktop runtime' error", async () => {
    const result = await computerUse({ action: "screenshot" })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Cognia desktop runtime/)
  })
})

describe("computerUse — sidecar path (with echo proxy)", () => {
  let server: net.Server
  let port: number
  const TOKEN = "test-token-1234"

  beforeAll(async () => {
    server = net.createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        let nl = buffer.indexOf("\n")
        while (nl >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          try {
            const req = JSON.parse(line)
            // Pretend every command succeeds; echo command name back.
            let result: unknown = { ok: true }
            if (req.command === "desktop_screenshot") {
              result = { bytes: "TEST", width: 100, height: 50 }
            } else if (req.command === "desktop_cursor_position") {
              result = { x: 7, y: 11 }
            }
            socket.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n")
          } catch {
            // ignore
          }
          nl = buffer.indexOf("\n")
        }
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const addr = server.address() as net.AddressInfo
    port = addr.port
  })

  afterAll(async () => {
    __testing__.resetProxyClient()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    mockedIsTauri.mockReturnValue(false)
    process.env.COGNIA_AUTOMATION_PROXY = `127.0.0.1:${port}`
    process.env.COGNIA_AUTOMATION_PROXY_TOKEN = TOKEN
  })

  afterEach(() => {
    __testing__.resetProxyClient()
    delete process.env.COGNIA_AUTOMATION_PROXY
    delete process.env.COGNIA_AUTOMATION_PROXY_TOKEN
  })

  it("screenshot round-trips through the proxy socket", async () => {
    const result = await computerUse({ action: "screenshot" })
    expect(result).toEqual({ ok: true, screenshot: "TEST", width: 100, height: 50 })
  })

  it("cursor_position round-trips through the proxy socket", async () => {
    const result = await computerUse({ action: "cursor_position" })
    expect(result).toEqual({ ok: true, cursor: { x: 7, y: 11 } })
  })

  it("click envelope reaches the proxy with count", async () => {
    const seen: Record<string, unknown>[] = []
    server.removeAllListeners("connection")
    server.on("connection", (socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        let nl = buffer.indexOf("\n")
        while (nl >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          try {
            const req = JSON.parse(line) as Record<string, unknown>
            seen.push(req)
            socket.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + "\n")
          } catch {
            // ignore
          }
          nl = buffer.indexOf("\n")
        }
      })
    })
    __testing__.resetProxyClient()

    const result = await computerUse({
      action: "click",
      coordinate: [50, 60],
      button: "left",
      count: 3,
    })
    expect(result).toEqual({ ok: true })
    expect(seen.length).toBeGreaterThan(0)
    const req = seen[0]
    expect(req.command).toBe("desktop_click")
    expect(req.token).toBe(TOKEN)
    const args = req.args as Record<string, unknown>
    expect(args.target).toEqual({ kind: "point", x: 50, y: 60 })
    expect(args.opts).toEqual({ button: "left", double: undefined, count: 3 })
  })
})
