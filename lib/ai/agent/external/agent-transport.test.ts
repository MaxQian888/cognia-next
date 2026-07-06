/**
 * Host indirection for the external-agent plane (ADR-0059 T-A10).
 *
 * @jest-environment node
 */
const invokeMock = jest.fn()
const listenMock = jest.fn()
const transportCall = jest.fn()
const transportSubscribe = jest.fn()

// Lazy wrappers: jest hoists the mock factories above the const declarations.
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: {
    call: (...args: unknown[]) => transportCall(...args),
    subscribe: (...args: unknown[]) => transportSubscribe(...args),
  },
}))

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  agentInvoke,
  agentListen,
  agentReadTextFile,
  agentWriteTextFile,
  supportsAgentFs,
  supportsAgentTerminal,
  supportsExternalAgents,
} from "./agent-transport"

const g = globalThis as Record<string, unknown>

function setTauri(on: boolean): void {
  const w = g.window as Record<string, unknown> | undefined
  if (on) {
    g.window = { ...(w ?? {}), __TAURI_INTERNALS__: {} }
  } else if (w) {
    delete (w as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

afterEach(() => {
  delete g.__COGNIA_HEADLESS__
  delete g.window
  jest.clearAllMocks()
})

describe("capability predicates", () => {
  it("browser: nothing supported", () => {
    expect(supportsExternalAgents()).toBe(false)
    expect(supportsAgentFs()).toBe(false)
    expect(supportsAgentTerminal()).toBe(false)
  })

  it("tauri: everything supported", () => {
    setTauri(true)
    expect(supportsExternalAgents()).toBe(true)
    expect(supportsAgentFs()).toBe(true)
    expect(supportsAgentTerminal()).toBe(true)
  })

  it("headless: agents + fs, but NOT terminal", () => {
    g.__COGNIA_HEADLESS__ = true
    expect(supportsExternalAgents()).toBe(true)
    expect(supportsAgentFs()).toBe(true)
    expect(supportsAgentTerminal()).toBe(false)
  })
})

describe("agentInvoke / agentListen routing", () => {
  it("tauri routes to invoke/listen", async () => {
    setTauri(true)
    invokeMock.mockResolvedValueOnce("pid-1")
    await expect(agentInvoke("spawn_external_agent", { config: {} })).resolves.toBe("pid-1")
    expect(invokeMock).toHaveBeenCalledWith("spawn_external_agent", { config: {} })

    const received: unknown[] = []
    listenMock.mockImplementationOnce(async (_event: string, handler: (e: unknown) => void) => {
      handler({ payload: { agentId: "a1", data: "line" } })
      return () => undefined
    })
    await agentListen("external-agent://stdout", (payload) => received.push(payload))
    // The adapter unwraps Tauri's { payload } envelope.
    expect(received).toEqual([{ agentId: "a1", data: "line" }])
  })

  it("headless routes to the process transport", async () => {
    g.__COGNIA_HEADLESS__ = true
    transportCall.mockResolvedValueOnce(null)
    await agentInvoke("kill_external_agent", { agentId: "a1" })
    expect(transportCall).toHaveBeenCalledWith("kill_external_agent", { agentId: "a1" })
    expect(invokeMock).not.toHaveBeenCalled()

    transportSubscribe.mockReturnValueOnce(() => undefined)
    const handler = jest.fn()
    await agentListen("external-agent://exit", handler)
    expect(transportSubscribe).toHaveBeenCalledWith("external-agent://exit", handler)
    expect(listenMock).not.toHaveBeenCalled()
  })
})

describe("agent fs seam", () => {
  it("headless reads/writes through node:fs", async () => {
    g.__COGNIA_HEADLESS__ = true
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fs-"))
    const file = path.join(dir, "note.txt")
    await agentWriteTextFile(file, "hello agent")
    await expect(agentReadTextFile(file)).resolves.toBe("hello agent")
  })

  it("browser throws", async () => {
    await expect(agentReadTextFile("/nope")).rejects.toThrow(/not available in browser/)
    await expect(agentWriteTextFile("/nope", "x")).rejects.toThrow(/not available in browser/)
  })
})

describe("static-import guard (T-A10 contract)", () => {
  it("acp-client has no static @tauri-apps imports left", () => {
    const source = fs.readFileSync(path.join(__dirname, "acp-client.ts"), "utf8")
    const staticImport = /^import[^\n]*from\s+"@tauri-apps\//m
    expect(staticImport.test(source)).toBe(false)
  })
})
