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
  __resetAgentProcessHostsForTests,
  agentInvoke,
  agentListen,
  agentReadTextFile,
  agentWriteTextFile,
  agentDeleteTextFile,
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
} from "./capability/process-plane"

import {
  setActiveRemoteTransport,
  setActiveRemoteEndpoint,
  __resetRoutingForTests,
} from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import type { InstalledExternalAgentProcessPlane } from "./host/installed-host"

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
  __resetRoutingForTests()
  __resetAgentProcessHostsForTests()
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

  // ADR-0182. Seven clients build a spawn payload and all of them come through
  // here, so this is where the run's placement is attached — and where the off
  // path has to stay byte-for-byte identical.
  it("attaches a registered runtime-environment placement to a spawn", async () => {
    const { registerSpawnPlacement, __resetSpawnPlacementsForTests } =
      await import("@/lib/sandbox/spawn-placement-registry")
    __resetSpawnPlacementsForTests()
    const placement = {
      kind: "container" as const,
      spec: { projectId: "prj1" } as never,
      isolationMandatory: true,
    }
    registerSpawnPlacement("agent-7", placement)

    setTauri(true)
    invokeMock.mockResolvedValueOnce("pid-7")
    await agentInvoke("spawn_external_agent", { config: { id: "agent-7", command: "codex" } })

    expect(invokeMock).toHaveBeenCalledWith("spawn_external_agent", {
      config: { id: "agent-7", command: "codex", sandbox: placement },
    })
    __resetSpawnPlacementsForTests()
  })

  it("sends the unchanged payload when no placement was registered", async () => {
    const { __resetSpawnPlacementsForTests } =
      await import("@/lib/sandbox/spawn-placement-registry")
    __resetSpawnPlacementsForTests()

    setTauri(true)
    invokeMock.mockResolvedValueOnce("pid-8")
    await agentInvoke("spawn_external_agent", { config: { id: "agent-8", command: "codex" } })

    expect(invokeMock).toHaveBeenCalledWith("spawn_external_agent", {
      config: { id: "agent-8", command: "codex" },
    })
  })

  it("leaves other commands alone even with a placement pending", async () => {
    const { registerSpawnPlacement, __resetSpawnPlacementsForTests } =
      await import("@/lib/sandbox/spawn-placement-registry")
    __resetSpawnPlacementsForTests()
    registerSpawnPlacement("agent-9", {
      kind: "container",
      spec: {} as never,
      isolationMandatory: false,
    })

    setTauri(true)
    invokeMock.mockResolvedValueOnce(null)
    await agentInvoke("kill_external_agent", { agentId: "agent-9" })
    expect(invokeMock).toHaveBeenCalledWith("kill_external_agent", { agentId: "agent-9" })
    __resetSpawnPlacementsForTests()
  })
})

describe("agent fs seam", () => {
  it("deletes only a file through the confined workspace RPC and rejects outside paths", async () => {
    g.__COGNIA_HEADLESS__ = true
    transportCall.mockResolvedValue(undefined)
    await agentDeleteTextFile("/workspace/session.json", ["/workspace"])
    expect(transportCall).toHaveBeenCalledWith("fs_delete_workspace_entry", {
      root: "/workspace",
      relPath: "session.json",
      recursive: false,
    })
    await expect(agentDeleteTextFile("/outside/session.json", ["/workspace"])).rejects.toThrow(
      /outside/
    )
  })
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
  it("the ACP client has no static @tauri-apps imports", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../../../packages/agent-acp/src/client.ts"),
      "utf8"
    )
    const staticImport = /^import[^\n]*from\s+"@tauri-apps\//m
    expect(staticImport.test(source)).toBe(false)
  })
})

it("contains native unregister rejections", async () => {
  const failures: Promise<void>[] = []
  const spies: jest.SpyInstance[] = []
  const off = jest.fn(() => {
    const failure = Promise.reject<void>(new TypeError("listeners[eventId].handlerId"))
    failures.push(failure)
    spies.push(jest.spyOn(failure, "catch"))
    return failure
  })
  setTauri(true)
  listenMock.mockResolvedValue(off)
  const stop = await agentListen("external-agent://exit", () => {})
  stop()
  const attached = spies.map((spy) => spy.mock.calls.length)
  await Promise.all(failures.map((failure) => failure.catch(() => {})))
  expect(attached).toEqual([1])
})

describe("remote Host process identity", () => {
  function remote(call = jest.fn().mockResolvedValue("remote-pid")) {
    return {
      call,
      subscribe: jest.fn().mockReturnValue(() => {}),
      whenSubscribed: jest.fn().mockResolvedValue(undefined),
    }
  }

  it("desktop spawns and subscribes through its selected Host", async () => {
    setTauri(true)
    const target = remote()
    setActiveRemoteTransport(target as Transport)
    await expect(
      agentInvoke("spawn_external_agent", { config: { id: "remote-agent" } })
    ).resolves.toBe("remote-pid")
    await agentListen("external-agent://stdout", jest.fn())
    expect(target.call).toHaveBeenCalledWith("spawn_external_agent", {
      config: { id: "remote-agent" },
    })
    expect(target.whenSubscribed).toHaveBeenCalledWith(["external-agent://stdout"])
    expect(invokeMock).not.toHaveBeenCalled()
    expect(listenMock).not.toHaveBeenCalled()
    expect(runsExternalAgentProcessesLocally()).toBe(false)
    expect(supportsAgentTerminal()).toBe(false)
  })

  it("refuses cross-Host sends and suppresses late events", async () => {
    setTauri(true)
    const first = remote()
    setActiveRemoteTransport(first as Transport)
    await agentInvoke("spawn_external_agent", { config: { id: "a" } })
    const handler = jest.fn()
    await agentListen("external-agent://stdout", handler)
    const second = remote()
    setActiveRemoteTransport(second as Transport)
    first.subscribe.mock.calls[0][1]({ agentId: "remote-pid", data: "late" })
    await expect(
      agentInvoke("send_to_external_agent", { agentId: "remote-pid", message: "secret" })
    ).rejects.toThrow("different Host")
    expect(handler).not.toHaveBeenCalled()
    expect(second.call).not.toHaveBeenCalled()
  })

  it("permits reconnecting to the same paired Host with a new transport", async () => {
    const endpoint = {
      baseUrl: "https://host.test",
      deviceId: "device-a",
      devicePrivateKeyJwk: {},
      deviceKeyThumbprint: "key-a",
      serverVersion: "4",
      serverFingerprint: "cert-a",
    }
    setActiveRemoteEndpoint(endpoint)
    setActiveRemoteTransport(remote() as Transport)
    await agentInvoke("spawn_external_agent", { config: { id: "a" } })
    const eventHandler = jest.fn()
    const unlisten = await agentListen("external-agent://stdout", eventHandler)
    const reconnected = remote()
    setActiveRemoteTransport(reconnected as Transport)
    await agentInvoke("send_to_external_agent", { agentId: "remote-pid", message: "resume" })
    expect(reconnected.call).toHaveBeenCalledWith("send_to_external_agent", {
      agentId: "remote-pid",
      message: "resume",
    })
    reconnected.subscribe.mock.calls[0][1]({ data: "resumed" })
    expect(eventHandler).toHaveBeenCalledWith({ data: "resumed" })
    unlisten()
    setActiveRemoteEndpoint({ ...endpoint, serverFingerprint: "cert-b" })
    await expect(agentInvoke("kill_external_agent", { agentId: "remote-pid" })).rejects.toThrow(
      "different Host"
    )
  })

  it("retains Host ownership when a spawn response is lost", async () => {
    const first = remote(jest.fn().mockRejectedValue(new Error("response lost")))
    setActiveRemoteTransport(first as Transport)
    await expect(
      agentInvoke("spawn_external_agent", { config: { id: "uncertain" } })
    ).rejects.toThrow("response lost")
    const second = remote()
    setActiveRemoteTransport(second as Transport)
    await expect(
      agentInvoke("spawn_external_agent", { config: { id: "uncertain" } })
    ).rejects.toThrow("different Host")
    expect(second.call).not.toHaveBeenCalled()
  })

  it("cleans a subscription when readiness fails", async () => {
    const target = remote()
    const off = jest.fn()
    target.subscribe.mockReturnValue(off)
    target.whenSubscribed.mockRejectedValue(new Error("offline"))
    setActiveRemoteTransport(target as Transport)
    await expect(agentListen("external-agent://exit", jest.fn())).rejects.toThrow("offline")
    expect(off).toHaveBeenCalledTimes(1)
  })

  it.each(["COGNIA_GATEWAY_TOKEN", "COGNIA_GATEWAY_TASK_CONFIG", "COGNIA_TOOLHOST_TOKEN"])(
    "refuses unsupported local bridge %s before transfer",
    async (key) => {
      const target = remote()
      setActiveRemoteTransport(target as Transport)
      await expect(
        agentInvoke("spawn_external_agent", { config: { id: "a", env: { [key]: "secret" } } })
      ).rejects.toThrow(
        key === "COGNIA_TOOLHOST_TOKEN"
          ? "transport is not configured"
          : "Remote gateway task lease"
      )
      expect(target.call).not.toHaveBeenCalled()
    }
  )
})

describe("installed external-agent host (ADR-0217)", () => {
  function processPlane() {
    return {
      supportsExternalAgents: jest.fn(() => true),
      runsExternalAgentProcessesLocally: jest.fn(() => true),
      supportsAgentFs: jest.fn(() => true),
      supportsAgentTerminal: jest.fn(() => false),
      getAcpHostCapabilities: jest.fn(() => ({ kind: "cli" }) as never),
      invoke: jest.fn(async () => "agent-1"),
      listen: jest.fn(async () => () => {}),
      readTextFile: jest.fn(async () => "text"),
      writeTextFile: jest.fn(async () => undefined),
      deleteTextFile: jest.fn(async () => undefined),
    }
  }

  it("delegates every export to the installed process plane and skips the app's transports", async () => {
    const { installExternalAgentHost } = await import("./host/installed-host")
    const plane = processPlane()
    const uninstall = installExternalAgentHost({
      kind: "test",
      // The mocks are concrete; the plane's invoke/listen are generic.
      process: plane as unknown as InstalledExternalAgentProcessPlane,
      terminals: {} as never,
      hooks: { run: async () => null, pluginHooks: null },
    })
    invokeMock.mockClear()
    listenMock.mockClear()
    transportCall.mockClear()
    try {
      expect(supportsExternalAgents()).toBe(true)
      expect(runsExternalAgentProcessesLocally()).toBe(true)
      expect(supportsAgentFs()).toBe(true)
      expect(supportsAgentTerminal()).toBe(false)
      expect(getAcpHostCapabilities()).toEqual({ kind: "cli" })

      const config = { id: "agent-1", command: "pi" }
      await expect(agentInvoke("spawn_external_agent", { config })).resolves.toBe("agent-1")
      // The caller's arguments arrive unchanged: the installed host owns placement.
      expect(plane.invoke).toHaveBeenCalledWith("spawn_external_agent", { config })

      const handler = jest.fn()
      await agentListen("external-agent://stdout", handler)
      expect(plane.listen).toHaveBeenCalledWith("external-agent://stdout", handler)

      await expect(agentReadTextFile("/w/a.txt", ["/w"])).resolves.toBe("text")
      await agentWriteTextFile("/w/a.txt", "x", ["/w"])
      await agentDeleteTextFile("/w/a.txt", ["/w"])
      expect(plane.readTextFile).toHaveBeenCalledWith("/w/a.txt", ["/w"])
      expect(plane.writeTextFile).toHaveBeenCalledWith("/w/a.txt", "x", ["/w"])
      expect(plane.deleteTextFile).toHaveBeenCalledWith("/w/a.txt", ["/w"])

      expect(invokeMock).not.toHaveBeenCalled()
      expect(listenMock).not.toHaveBeenCalled()
      expect(transportCall).not.toHaveBeenCalled()
    } finally {
      uninstall()
    }
  })
})
