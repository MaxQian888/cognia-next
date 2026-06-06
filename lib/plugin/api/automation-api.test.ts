/**
 * Tests for the desktop Automation Plugin API (`ctx.automation`).
 *
 * Verifies: (1) every method is gated behind its specific `automation:*`
 * permission, (2) granted calls forward to the `lib/automation/client`
 * `desktop.*` surface, and (3) every call is stamped with
 * `{ surface: "plugin", pluginId }` so the Rust per-surface gate fires.
 */

import { createAutomationAPI } from "./automation-api"
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
    guard = getPermissionGuard()
  })

  it("gates each method behind its specific automation permission", () => {
    guard.registerPlugin(PLUGIN, [])
    const api = createAutomationAPI(PLUGIN)
    expect(() => api.screenshot()).toThrow(PermissionError)
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
