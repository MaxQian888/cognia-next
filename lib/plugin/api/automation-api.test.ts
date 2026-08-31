/**
 * Tests for the desktop Automation Plugin API (`ctx.automation`).
 *
 * Verifies: (1) every method is gated behind its specific `automation:*`
 * permission, (2) granted calls forward to the `lib/automation/client`
 * `desktop.*` surface, and (3) every call is stamped with
 * `{ surface: "plugin", pluginId }` so the Rust per-surface gate fires.
 */

import { createAutomationAPI } from "./automation-api"
import { getComputerUsePipSnapshot } from "@/lib/automation/computer-use-pip"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"

const desktop = {
  capabilities: jest.fn(async () => ({ screenshot: true })),
  getFocus: jest.fn(async () => ({ name: "btn" })),
  readTree: jest.fn(async () => [{ name: "root" }]),
  find: jest.fn(async () => ({ id: "el-1" })),
  cursorPosition: jest.fn(async () => ({ x: 1, y: 2 })),
  pickAtPoint: jest.fn(async () => ({ name: "picked" })),
  screenshot: jest.fn(async () => ({ width: 10, height: 10, dataB64: "" })),
  listApps: jest.fn(async () => [{ displayName: "Notes" }]),
  getAppState: jest.fn(async () => ({ sessionId: "desktop-1", lineageId: "l1", revision: 1 })),
  queryElements: jest.fn(async () => []),
  expandElement: jest.fn(async () => ({ elements: [] })),
  performAction: jest.fn(async () => ({ success: true })),
  zoom: jest.fn(async () => ({
    sessionId: "desktop-1",
    lineageId: "l1",
    revision: 1,
    region: { x: 0, y: 0, width: 10, height: 10 },
    screenshot: { bytes: "WlZa", width: 10, height: 10, capturedAt: 1, format: "png" },
  })),
  click: jest.fn(async () => undefined),
  mouseButton: jest.fn(async () => undefined),
  type: jest.fn(async () => undefined),
  keys: jest.fn(async () => undefined),
  holdKey: jest.fn(async () => undefined),
  mouseMove: jest.fn(async () => undefined),
  drag: jest.fn(async () => undefined),
  scroll: jest.fn(async () => undefined),
  windowOp: jest.fn(async () => undefined),
  paste: jest.fn(async () => undefined),
  launchApp: jest.fn(async () => undefined),
}
jest.mock("@/lib/automation/client", () => ({
  desktop: new Proxy(
    {},
    {
      get:
        (_t, prop: string) =>
        (...args: unknown[]) =>
          (desktop as Record<string, (...a: unknown[]) => unknown>)[prop](...args),
    }
  ),
}))

const PLUGIN = "auto-plugin"
const PLUGIN_CTX = { surface: "plugin", pluginId: PLUGIN }

describe("createAutomationAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    resetPermissionGuard()
    guard = getPermissionGuard({ confirmDangerousByDefault: false })
  })

  it("gates each method behind its specific automation permission", () => {
    guard.registerPlugin(PLUGIN, [])
    const api = createAutomationAPI(PLUGIN)
    expect(() => api.screenshot()).toThrow(PermissionError)
    expect(() => api.captureDisplay()).toThrow(PermissionError)
    expect(() => api.listApps()).toThrow(PermissionError)
    expect(() => api.getFocus()).toThrow(PermissionError)
    expect(() => api.click({ x: 0, y: 0 } as never)).toThrow(PermissionError)
    expect(() => api.type("hi")).toThrow(PermissionError)
    expect(() => api.paste("hi")).toThrow(PermissionError)
    expect(() => api.mouseMove({ x: 0, y: 0 })).toThrow(PermissionError)
    expect(() => api.windowOp({ id: "w" } as never, "focus" as never)).toThrow(PermissionError)
    expect(() => api.launchApp("notepad.exe", "launch")).toThrow(PermissionError)
  })

  it("does not let an unrelated permission unlock another group", () => {
    guard.registerPlugin(PLUGIN, ["automation:read"])
    const api = createAutomationAPI(PLUGIN)
    // read is granted...
    expect(() => api.getFocus()).not.toThrow()
    // ...but click / type / screenshot are still denied
    expect(() => api.click({ x: 0, y: 0 } as never)).toThrow(PermissionError)
    expect(() => api.screenshot()).toThrow(PermissionError)
  })

  describe("granted (all automation permissions)", () => {
    beforeEach(() =>
      guard.registerPlugin(PLUGIN, [
        "automation:screenshot",
        "automation:read",
        "automation:click",
        "automation:type",
        "automation:pointer",
        "automation:window",
      ])
    )

    it("forwards read calls tagged with the plugin surface", async () => {
      const api = createAutomationAPI(PLUGIN)
      expect(await api.capabilities()).toMatchObject({ screenshot: true })
      await api.getFocus()
      expect(desktop.getFocus).toHaveBeenCalledWith(PLUGIN_CTX)
      await api.readTree()
      expect(desktop.readTree).toHaveBeenCalledWith(null, {}, PLUGIN_CTX)
      await api.find({ role: "button" } as never)
      expect(desktop.find).toHaveBeenCalledWith({ role: "button" }, PLUGIN_CTX)
      await api.cursorPosition()
      expect(desktop.cursorPosition).toHaveBeenCalledWith(PLUGIN_CTX)
    })

    it("forwards action calls with the plugin surface stamped", async () => {
      const api = createAutomationAPI(PLUGIN)
      await api.screenshot({ region: { x: 0, y: 0, width: 5, height: 5 } } as never)
      expect(desktop.screenshot).toHaveBeenCalledWith(
        { region: { x: 0, y: 0, width: 5, height: 5 } },
        PLUGIN_CTX
      )
      await api.click({ x: 3, y: 4 } as never)
      expect(desktop.click).toHaveBeenCalledWith({ x: 3, y: 4 }, {}, PLUGIN_CTX)
      await api.type("hello")
      expect(desktop.type).toHaveBeenCalledWith("hello", {}, PLUGIN_CTX)
      await api.keys({ key: "c", modifiers: ["ctrl"] } as never)
      expect(desktop.keys).toHaveBeenCalledWith({ key: "c", modifiers: ["ctrl"] }, PLUGIN_CTX)
      await api.drag({ x: 0, y: 0 }, { x: 9, y: 9 })
      expect(desktop.drag).toHaveBeenCalledWith({ x: 0, y: 0 }, { x: 9, y: 9 }, {}, PLUGIN_CTX)
      await api.windowOp({ id: "w" } as never, "maximize" as never)
      expect(desktop.windowOp).toHaveBeenCalledWith({ id: "w" }, "maximize", PLUGIN_CTX)
    })

    it("owns display capture and revision-bound Computer Use provenance", async () => {
      const captureDisplay = jest.fn(async () => new File(["png"], "screen.png"))
      const getComputerUseSettings = jest.fn(() => ({ requireConsent: true }))
      const decorateComputerUseContext = jest.fn(async (_ref, context) => ({
        ...context,
        sandboxConnectionId: "remote-1",
      }))
      const runtime = {
        desktop,
        captureDisplay,
        getComputerUseSettings,
        focusedSessionId: jest.fn(() => undefined),
        sandbox: {
          hostFallbackRuntimeRef: "host-fallback",
          activeRefForSession: jest.fn(() => "runtime-1"),
          decorateComputerUseContext,
        },
      }
      const api = createAutomationAPI(PLUGIN, runtime as never)

      await expect(api.captureDisplay()).resolves.toMatchObject({ name: "screen.png" })
      expect(captureDisplay).toHaveBeenCalledTimes(1)

      const origin = { sessionId: "chat-1", messageId: "message-1" }
      await api.listApps(origin)
      const expectedContext = {
        surface: "computerUse",
        pluginId: PLUGIN,
        sessionKey: "chat-1",
        turnKey: "message-1",
        forceTier: "perCall",
        sandboxConnectionId: "remote-1",
      }
      expect(desktop.listApps).toHaveBeenCalledWith(expectedContext)
      expect(decorateComputerUseContext).toHaveBeenCalledWith(
        "runtime-1",
        expect.objectContaining({ surface: "computerUse", pluginId: PLUGIN })
      )

      await api.getAppState("desktop-1", { kind: "displayName", displayName: "Notes" }, {}, origin)
      expect(desktop.getAppState).toHaveBeenCalledWith(
        "desktop-1",
        { kind: "displayName", displayName: "Notes" },
        {},
        expectedContext
      )
      await api.queryElements(
        { sessionId: "desktop-1", lineageId: "l1", revision: 1 },
        { nameContains: "Save" },
        10,
        origin
      )
      expect(desktop.queryElements).toHaveBeenCalledWith(
        { sessionId: "desktop-1", lineageId: "l1", revision: 1 },
        { nameContains: "Save" },
        10,
        expectedContext
      )
      await api.expandElement({ sessionId: "desktop-1" } as never, null, 25, origin)
      expect(desktop.expandElement).toHaveBeenCalledWith(
        { sessionId: "desktop-1" },
        null,
        25,
        expectedContext
      )
      await api.performAction({ kind: "click" } as never, origin)
      expect(desktop.performAction).toHaveBeenCalledWith({ kind: "click" }, expectedContext)
    })

    it("still upgrades consent from the focused session when the caller has no sessionId", async () => {
      const getComputerUseSettings = jest.fn(() => ({ requireConsent: true }))
      const activeRefForSession = jest.fn(() => undefined)
      const runtime = {
        desktop,
        captureDisplay: jest.fn(),
        getComputerUseSettings,
        focusedSessionId: jest.fn(() => "focused-chat"),
        sandbox: {
          hostFallbackRuntimeRef: "host-fallback",
          activeRefForSession,
          decorateComputerUseContext: jest.fn(async (_ref, context) => context),
        },
      }
      const api = createAutomationAPI(PLUGIN, runtime as never)

      // A workflow node / plan step / bridge call carries no session of its own.
      await api.listApps()

      expect(getComputerUseSettings).toHaveBeenCalledWith("focused-chat")
      expect(desktop.listApps).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "focused-chat", forceTier: "perCall" })
      )
      // Placement must NOT borrow the focused session's binding.
      expect(activeRefForSession).toHaveBeenCalledWith(undefined)
      expect(runtime.sandbox.decorateComputerUseContext).toHaveBeenCalledWith(
        "host-fallback",
        expect.anything()
      )
    })

    it("forwards paste + launchApp tagged with the plugin surface", async () => {
      const api = createAutomationAPI(PLUGIN)
      await api.paste("long text")
      expect(desktop.paste).toHaveBeenCalledWith("long text", PLUGIN_CTX)
      await api.launchApp("notepad.exe", "launch")
      expect(desktop.launchApp).toHaveBeenCalledWith("notepad.exe", "launch", PLUGIN_CTX)
    })

    it("forwards the remaining read + pointer + low-level primitives", async () => {
      const api = createAutomationAPI(PLUGIN)
      await api.pickAtPoint({ x: 7, y: 8 })
      expect(desktop.pickAtPoint).toHaveBeenCalledWith({ x: 7, y: 8 }, PLUGIN_CTX)
      await api.mouseButton("left" as never, "down" as never)
      expect(desktop.mouseButton).toHaveBeenCalledWith("left", "down", PLUGIN_CTX)
      await api.holdKey({ key: "a" } as never, 250)
      expect(desktop.holdKey).toHaveBeenCalledWith({ key: "a" }, 250, PLUGIN_CTX)
      await api.mouseMove({ x: 2, y: 2 })
      expect(desktop.mouseMove).toHaveBeenCalledWith({ x: 2, y: 2 }, PLUGIN_CTX)
      await api.scroll({ x: 1, y: 1 } as never, { dy: -3 } as never)
      expect(desktop.scroll).toHaveBeenCalledWith({ x: 1, y: 1 }, { dy: -3 }, PLUGIN_CTX)
    })
  })
})

describe("picture-in-picture live view", () => {
  // The PiP surface had no producer on this path: its only publishers lived in
  // the OCR fallback module, so during a real computer-use turn the component
  // mounted, saw no activity, and never appeared.
  const guardFor = (permissions: string[]) => {
    resetPermissionGuard()
    const g = getPermissionGuard({ confirmDangerousByDefault: false })
    g.registerPlugin(PLUGIN, permissions)
    return g
  }

  beforeEach(() => {
    jest.clearAllMocks()
    guardFor([
      "automation:screenshot",
      "automation:read",
      "automation:click",
      "automation:type",
      "automation:pointer",
      "automation:window",
    ])
  })

  it("publishes activity and a frame for get_app_state", async () => {
    desktop.getAppState.mockResolvedValueOnce({
      sessionId: "desktop-1",
      lineageId: "l1",
      revision: 3,
      screenshot: { bytes: "QUJD", width: 800, height: 600, capturedAt: 5, format: "png" },
    } as never)
    const api = createAutomationAPI(PLUGIN)
    await api.getAppState("s", { kind: "bundleId", bundleId: "com.apple.Notes" } as never, {}, {
      sessionId: "chat-1",
    } as never)

    const snapshot = getComputerUsePipSnapshot("chat-1")
    expect(snapshot.action).toBe("get_app_state")
    expect(snapshot.phase).toBe("complete")
    expect(snapshot.frame?.src).toContain("QUJD")
  })

  it("publishes an error phase when the call throws", async () => {
    desktop.performAction.mockRejectedValueOnce(new Error("consent declined"))
    const api = createAutomationAPI(PLUGIN)
    await expect(
      api.performAction({ turnToken: "t" } as never, { sessionId: "chat-2" } as never)
    ).rejects.toThrow("consent declined")

    const snapshot = getComputerUsePipSnapshot("chat-2")
    expect(snapshot.action).toBe("perform_action")
    expect(snapshot.phase).toBe("error")
    expect(snapshot.error).toBe("consent declined")
  })

  it("does not publish a frame when the screenshot was withheld", async () => {
    // A deduped frame carries dimensions but no bytes. Publishing it would
    // blank the live view with an empty image.
    desktop.getAppState.mockResolvedValueOnce({
      sessionId: "desktop-1",
      lineageId: "l1",
      revision: 4,
      screenshot: { bytes: "", width: 800, height: 600, capturedAt: 5, format: "png" },
    } as never)
    const api = createAutomationAPI(PLUGIN)
    await api.getAppState("s", { kind: "bundleId", bundleId: "x" } as never, {}, {
      sessionId: "chat-3",
    } as never)
    expect(getComputerUsePipSnapshot("chat-3").frame).toBeNull()
  })
})
