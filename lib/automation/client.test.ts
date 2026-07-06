/**
 * Unit tests for `lib/automation/client.ts`.
 *
 * The transport layer is mocked so we can assert each automation client
 * method marshals the Tauri command name and payload correctly. The actual
 * Tauri IPC is not exercised here — that's covered by Rust-side integration
 * tests on a Windows runner.
 */

// Mock the transport *before* importing the client so the client picks up
// the mock at module-load time.
jest.mock("@/lib/tauri", () => ({
  transport: {
    call: jest.fn(),
  },
}))

import { transport } from "@/lib/tauri"

import { desktop, defaultAutomationSettings } from "./client"
import { elementRef, keyChord } from "./types"

const mockCall = transport.call as unknown as jest.Mock

afterEach(() => {
  mockCall.mockReset()
})

describe("desktop client", () => {
  it("desktop.capabilities invokes desktop_capabilities with empty args", async () => {
    mockCall.mockResolvedValueOnce({
      platform: "windows",
      hasUia: true,
      hasInputSim: true,
      hasScreenshot: true,
      hasEvents: true,
    })
    const caps = await desktop.capabilities()
    expect(mockCall).toHaveBeenCalledWith("desktop_capabilities", {})
    expect(caps.platform).toBe("windows")
  })

  it("desktop.getFocus forwards ctx", async () => {
    mockCall.mockResolvedValueOnce({})
    await desktop.getFocus({ surface: "mcp", pluginId: "demo" })
    expect(mockCall).toHaveBeenCalledWith("desktop_get_focus", {
      ctx: { surface: "mcp", pluginId: "demo" },
    })
  })

  it("desktop.readTree marshals root + opts + ctx", async () => {
    mockCall.mockResolvedValueOnce([])
    const r = elementRef("abc")
    await desktop.readTree(r, { maxDepth: 3 }, { surface: "workflow" })
    expect(mockCall).toHaveBeenCalledWith("desktop_read_tree", {
      args: {
        root: r,
        opts: { maxDepth: 3 },
        ctx: { surface: "workflow" },
      },
    })
  })

  it("desktop.find marshals locator + ctx", async () => {
    mockCall.mockResolvedValueOnce(null)
    await desktop.find({ name: "OK" }, { surface: "computerUse" })
    expect(mockCall).toHaveBeenCalledWith("desktop_find", {
      args: { locator: { name: "OK" }, ctx: { surface: "computerUse" } },
    })
  })

  it("desktop.screenshot marshals opts + ctx", async () => {
    mockCall.mockResolvedValueOnce({
      bytes: "AA==",
      width: 0,
      height: 0,
      capturedAt: 0,
      format: "png",
    })
    await desktop.screenshot({ format: "png" }, { surface: "mcp" })
    expect(mockCall).toHaveBeenCalledWith("desktop_screenshot", {
      args: { opts: { format: "png" }, ctx: { surface: "mcp" } },
    })
  })

  it("desktop.click marshals target + opts + ctx", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    const target = { kind: "point" as const, x: 10, y: 20 }
    await desktop.click(target, { button: "left" }, { surface: "workflow" })
    expect(mockCall).toHaveBeenCalledWith("desktop_click", {
      args: { target, opts: { button: "left" }, ctx: { surface: "workflow" } },
    })
  })

  it("desktop.type marshals text + opts + ctx", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    await desktop.type("hello", { delayMs: 5 }, { surface: "plugin", pluginId: "p1" })
    expect(mockCall).toHaveBeenCalledWith("desktop_type", {
      args: { text: "hello", opts: { delayMs: 5 }, ctx: { surface: "plugin", pluginId: "p1" } },
    })
  })

  it("desktop.keys marshals chord + ctx", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    await desktop.keys(keyChord("ctrl+shift+t"))
    expect(mockCall).toHaveBeenCalledWith("desktop_keys", {
      args: { chord: keyChord("ctrl+shift+t"), ctx: {} },
    })
  })

  it("desktop.invokePattern marshals target + pattern + args + ctx", async () => {
    mockCall.mockResolvedValueOnce({})
    const target = elementRef("xyz")
    await desktop.invokePattern(target, "invoke", { value: "x" }, { surface: "workflow" })
    expect(mockCall).toHaveBeenCalledWith("desktop_invoke_pattern", {
      args: {
        target,
        pattern: "invoke",
        args: { value: "x" },
        ctx: { surface: "workflow" },
      },
    })
  })

  it("desktop.auditSnapshot returns the array", async () => {
    mockCall.mockResolvedValueOnce([])
    const snap = await desktop.auditSnapshot()
    expect(snap).toEqual([])
    expect(mockCall).toHaveBeenCalledWith("automation_audit_snapshot", {})
  })

  it("desktop.settingsGet / settingsSet round-trip", async () => {
    const s = defaultAutomationSettings()
    mockCall.mockResolvedValueOnce(s).mockResolvedValueOnce(undefined)
    const got = await desktop.settingsGet()
    expect(got).toEqual(s)
    await desktop.settingsSet(s)
    expect(mockCall).toHaveBeenCalledWith("automation_settings_set", { settings: s })
  })

  it("desktop.setEnabled invokes the dedicated enable command", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    await desktop.setEnabled(true)
    expect(mockCall).toHaveBeenCalledWith("automation_set_enabled", { enabled: true })
  })

  it("desktop.killSwitchEngaged reads the engaged flag", async () => {
    mockCall.mockResolvedValueOnce(true)
    await expect(desktop.killSwitchEngaged()).resolves.toBe(true)
    expect(mockCall).toHaveBeenCalledWith("automation_kill_switch_engaged", {})
  })

  it("desktop.killSwitch invokes the kill switch command", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    await desktop.killSwitch()
    expect(mockCall).toHaveBeenCalledWith("automation_kill_switch", {})
  })

  it("desktop.cursorPosition returns Point and forwards ctx", async () => {
    mockCall.mockResolvedValueOnce({ x: 12, y: 34 })
    const point = await desktop.cursorPosition({ surface: "computerUse" })
    expect(point).toEqual({ x: 12, y: 34 })
    expect(mockCall).toHaveBeenCalledWith("desktop_cursor_position", {
      ctx: { surface: "computerUse" },
    })
  })

  it("desktop.cursorPosition accepts no ctx", async () => {
    mockCall.mockResolvedValueOnce({ x: 0, y: 0 })
    await desktop.cursorPosition()
    expect(mockCall).toHaveBeenCalledWith("desktop_cursor_position", { ctx: undefined })
  })

  it("desktop.click marshals count for triple-click", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    const target = { kind: "point" as const, x: 5, y: 6 }
    await desktop.click(target, { count: 3 }, { surface: "computerUse" })
    expect(mockCall).toHaveBeenCalledWith("desktop_click", {
      args: { target, opts: { count: 3 }, ctx: { surface: "computerUse" } },
    })
  })

  it("M5 pointer/key primitives marshal their commands", async () => {
    mockCall.mockResolvedValue(undefined)
    await desktop.mouseMove({ x: 1, y: 2 }, { surface: "computerUse" })
    expect(mockCall).toHaveBeenCalledWith("desktop_mouse_move", {
      args: { point: { x: 1, y: 2 }, ctx: { surface: "computerUse" } },
    })
    await desktop.drag({ x: 0, y: 0 }, { x: 5, y: 5 })
    expect(mockCall).toHaveBeenCalledWith("desktop_drag", {
      args: { from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, opts: {}, ctx: {} },
    })
    await desktop.scroll({ kind: "point", x: 3, y: 4 }, { dy: 120 })
    expect(mockCall).toHaveBeenCalledWith("desktop_scroll", {
      args: { target: { kind: "point", x: 3, y: 4 }, opts: { dy: 120 }, ctx: {} },
    })
    await desktop.holdKey(keyChord("shift"), 500)
    expect(mockCall).toHaveBeenCalledWith("desktop_hold_key", {
      args: { chord: keyChord("shift"), durationMs: 500, ctx: {} },
    })
    await desktop.mouseButton("left", "down")
    expect(mockCall).toHaveBeenCalledWith("desktop_mouse_button", {
      args: { button: "left", transition: "down", ctx: {} },
    })
    await desktop.windowOp(elementRef("w1"), { kind: "focus" })
    expect(mockCall).toHaveBeenCalledWith("desktop_window_op", {
      args: { target: elementRef("w1"), op: { kind: "focus" }, ctx: {} },
    })
  })

  it("pick affordance commands marshal point + session lifecycle", async () => {
    mockCall.mockResolvedValue(undefined)
    await desktop.pickAtPoint({ x: 9, y: 9 }, { surface: "computerUse" })
    expect(mockCall).toHaveBeenCalledWith("desktop_pick_at_point", {
      args: { point: { x: 9, y: 9 }, ctx: { surface: "computerUse" } },
    })
    await desktop.pickSessionStart()
    expect(mockCall).toHaveBeenCalledWith("desktop_pick_session_start", { args: { ctx: {} } })
    await desktop.pickSessionCancel()
    expect(mockCall).toHaveBeenCalledWith("desktop_pick_session_cancel", { args: { ctx: {} } })
  })

  it("consentRespond forwards the broker reply", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    await desktop.consentRespond({ id: "c1", allow: true, persist: true })
    expect(mockCall).toHaveBeenCalledWith("automation_consent_respond", {
      args: { id: "c1", allow: true, persist: true },
    })
  })

  it("virtual display commands marshal correctly", async () => {
    mockCall.mockResolvedValue(undefined)
    await desktop.virtualDisplayHealthProbe()
    expect(mockCall).toHaveBeenCalledWith("virtual_display_health_probe", {})
    await desktop.virtualDisplaySetup()
    expect(mockCall).toHaveBeenCalledWith("virtual_display_setup", {})
    await desktop.virtualDisplayProbe()
    expect(mockCall).toHaveBeenCalledWith("virtual_display_probe", {})
    await desktop.virtualDisplayArm()
    expect(mockCall).toHaveBeenCalledWith("virtual_display_arm", {})
    await desktop.virtualDisplayRelease("sess-9")
    expect(mockCall).toHaveBeenCalledWith("virtual_display_release", {
      args: { sessionId: "sess-9" },
    })
  })

  it("desktop.paste posts text through desktop_paste", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    await desktop.paste("hello", { surface: "workflow" })
    expect(mockCall).toHaveBeenCalledWith("desktop_paste", {
      args: { text: "hello", ctx: { surface: "workflow" } },
    })
  })

  it("desktop.launchApp posts app + action", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    await desktop.launchApp("notepad.exe", "launch", { surface: "workflow" })
    expect(mockCall).toHaveBeenCalledWith("desktop_launch_app", {
      args: { app: "notepad.exe", action: "launch", ctx: { surface: "workflow" } },
    })
  })

  it("desktop.launchApp focus variant", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    await desktop.launchApp("notepad.exe", "focus")
    expect(mockCall).toHaveBeenCalledWith("desktop_launch_app", {
      args: { app: "notepad.exe", action: "focus", ctx: {} },
    })
  })
})

describe("defaultAutomationSettings", () => {
  it("is fully disabled by default", () => {
    const s = defaultAutomationSettings()
    expect(s.enabled).toBe(false)
    expect(s.defaultTier).toBe("off")
    expect(s.perSurface.workflow.tier).toBe("off")
    expect(s.perSurface.plugin.perPluginOverrides).toEqual({})
  })

  it("includes behavior defaults (scaling off, dedup on, paste 200)", () => {
    const s = defaultAutomationSettings()
    expect(s.screenshotScaling).toEqual({ enabled: false, maxWidth: 1280, maxHeight: 800 })
    expect(s.screenshotDedup).toBe(true)
    expect(s.pasteThresholdChars).toBe(200)
  })
})
