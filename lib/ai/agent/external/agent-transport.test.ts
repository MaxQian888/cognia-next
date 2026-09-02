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
  getAcpHostCapabilities,
  runsExternalAgentProcessesLocally,
  supportsAgentFs,
  supportsAgentTerminal,
  supportsExternalAgents,
} from "./agent-transport"
import {
  __setProcessPlaneDepsForTests,
  PROCESS_PLANE_COMMANDS,
  PROCESS_PLANE_FEATURE,
  PROCESS_SPAWN_CAPABILITY,
} from "./process-plane"

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
    expect(getAcpHostCapabilities()).toMatchObject({
      kind: "headless",
      fs: { read: false, write: false },
      terminal: false,
    })
  })

  it("separates a Host that can spawn from a shell that can", () => {
    // A paired browser reaches `spawn_external_agent` over the companion
    // plane, so agents are supported. It still has no process table, and a
    // local-only command (the DSH runtime's facts/install arms) cannot be
    // answered for it by any Host. Collapsing the two is what offered those
    // controls to a tab that could only get a transport error back.
    const restore = __setProcessPlaneDepsForTests({
      hasLocalProcessTable: () => false,
      isRemoteHostActive: () => true,
      activeHostId: () => "host-1",
      activeHostFeatureManifest: () =>
        ({
          schemaVersion: 2,
          hostId: "host-1",
          deviceGrants: [PROCESS_SPAWN_CAPABILITY],
          operations: [{ name: PROCESS_PLANE_COMMANDS.spawn, healthy: true }],
          features: {
            [PROCESS_PLANE_FEATURE]: {
              version: 1,
              operations: [PROCESS_PLANE_COMMANDS.spawn],
            },
          },
        }) as never,
    })
    try {
      expect(supportsExternalAgents()).toBe(true)
      expect(runsExternalAgentProcessesLocally()).toBe(false)
    } finally {
      restore()
    }
  })

  it("tauri: everything supported", () => {
    setTauri(true)
    expect(supportsExternalAgents()).toBe(true)
    expect(supportsAgentFs()).toBe(true)
    expect(supportsAgentTerminal()).toBe(true)
    expect(getAcpHostCapabilities()).toMatchObject({
      kind: "desktop",
      terminal: true,
      elicitation: { durableInteraction: true },
    })
  })

  it("headless: agents + fs, but NOT terminal", () => {
    g.__COGNIA_HEADLESS__ = true
    expect(supportsExternalAgents()).toBe(true)
    expect(supportsAgentFs()).toBe(true)
    expect(supportsAgentTerminal()).toBe(false)
    expect(getAcpHostCapabilities()).toMatchObject({
      kind: "headless",
      terminal: false,
      elicitation: { durableInteraction: false },
    })
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
  it("headless routes reads and writes through the confined workspace RPCs", async () => {
    g.__COGNIA_HEADLESS__ = true
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fs-"))
    const file = path.join(root, "nested", "note.txt")
    transportCall.mockResolvedValueOnce(null).mockResolvedValueOnce("hello agent")

    await agentWriteTextFile(file, "hello agent", [root])
    await expect(agentReadTextFile(file, [root])).resolves.toBe("hello agent")

    expect(transportCall).toHaveBeenNthCalledWith(1, "fs_write_workspace_file", {
      root,
      relPath: path.join("nested", "note.txt"),
      content: "hello agent",
    })
    expect(transportCall).toHaveBeenNthCalledWith(2, "fs_read_workspace_file", {
      root,
      relPath: path.join("nested", "note.txt"),
      maxBytes: undefined,
    })
  })

  it("rejects paths outside the session roots before calling the host", async () => {
    g.__COGNIA_HEADLESS__ = true

    await expect(agentReadTextFile("/private/secret", ["/workspace"])).rejects.toThrow(
      /outside.*session workspace roots/i
    )
    await expect(agentWriteTextFile("/private/secret", "x", ["/workspace"])).rejects.toThrow(
      /outside.*session workspace roots/i
    )
    expect(transportCall).not.toHaveBeenCalled()
  })

  it("routes Win32 drive and UNC paths under their matching roots", async () => {
    g.__COGNIA_HEADLESS__ = true
    transportCall.mockResolvedValue("ok")

    await expect(agentReadTextFile("C:\\work\\src\\main.ts", ["C:\\work"])).resolves.toBe("ok")
    await expect(
      agentReadTextFile("\\\\server\\share\\project\\README.md", ["\\\\server\\share\\project"])
    ).resolves.toBe("ok")

    expect(transportCall).toHaveBeenNthCalledWith(1, "fs_read_workspace_file", {
      root: "C:\\work",
      relPath: "src\\main.ts",
      maxBytes: undefined,
    })
    expect(transportCall).toHaveBeenNthCalledWith(2, "fs_read_workspace_file", {
      root: "\\\\server\\share\\project",
      relPath: "README.md",
      maxBytes: undefined,
    })
  })

  it("rejects Win32 drive and UNC paths outside their configured roots", async () => {
    g.__COGNIA_HEADLESS__ = true

    await expect(agentReadTextFile("D:\\secret.txt", ["C:\\work"])).rejects.toThrow(/outside/i)
    await expect(
      agentReadTextFile("\\\\server\\other\\secret.txt", ["\\\\server\\share"])
    ).rejects.toThrow(/outside/i)
    expect(transportCall).not.toHaveBeenCalled()
  })

  it("browser throws", async () => {
    await expect(agentReadTextFile("/nope", ["/"])).rejects.toThrow(/not available in browser/)
    await expect(agentWriteTextFile("/nope", "x", ["/"])).rejects.toThrow(
      /not available in browser/
    )
  })
})

describe("static-import guard (T-A10 contract)", () => {
  it("acp-client has no static @tauri-apps imports left", () => {
    const source = fs.readFileSync(path.join(__dirname, "acp-client.ts"), "utf8")
    const staticImport = /^import[^\n]*from\s+"@tauri-apps\//m
    expect(staticImport.test(source)).toBe(false)
  })
})
