/** @jest-environment jsdom */
/**
 * Tests for the fleet Tauri wrappers: web no-ops (isTauri false), happy-path
 * invoke pass-through, and error swallowing (a failed command never throws
 * into the renderer). Mirrors pet-window.test.ts.
 */

const invokeMock = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const revealMock = jest.fn()
jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: (...args: unknown[]) => revealMock(...args),
}))

import {
  closeIslandWindow,
  fleetCodexInstall,
  fleetCodexStatus,
  fleetCodexHooksInstall,
  fleetCodexHooksUninstall,
  fleetCodexHooksStatus,
  fleetCodexUninstall,
  fleetOpencodeInstall,
  fleetOpencodeStatus,
  fleetOpencodeUninstall,
  fleetOpencodeSendMessage,
  fleetFocusTerminal,
  fleetGetSnapshot,
  fleetMonitorRestore,
  fleetMonitorStart,
  fleetMonitorStatus,
  fleetMonitorStop,
  fleetPermissionRespond,
  fleetQuestionRespond,
  fleetRevealTranscript,
  islandListMonitors,
  islandResize,
  islandSetMonitor,
  islandSetTucked,
  isIslandWindowOpen,
  openIslandWindow,
} from "./fleet"

const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

beforeEach(() => {
  invokeMock.mockReset()
  revealMock.mockReset()
  isTauriMock.mockReturnValue(true)
  warnSpy.mockClear()
})

afterAll(() => warnSpy.mockRestore())

describe("off Tauri (web)", () => {
  beforeEach(() => isTauriMock.mockReturnValue(false))

  it("returns benign values without invoking", async () => {
    expect(await fleetMonitorStart()).toBeNull()
    expect(await fleetMonitorStop()).toEqual({ enabled: false, port: null, configPath: null })
    expect(await fleetMonitorStatus()).toEqual({ enabled: false, port: null, configPath: null })
    expect(await fleetMonitorRestore()).toEqual({ enabled: false, port: null, configPath: null })
    expect(await fleetGetSnapshot()).toEqual({ sessions: [], generatedAt: 0 })
    expect(await fleetPermissionRespond("r", "allow")).toBe(false)
    expect(await fleetQuestionRespond("r", [[0]])).toBe(false)
    expect(await fleetFocusTerminal("claude-code", "s")).toBe(false)
    expect(await fleetCodexStatus()).toEqual({
      status: "unavailable",
      configPath: null,
      scriptPath: null,
    })
    expect(await fleetCodexInstall()).toEqual({
      status: "unavailable",
      configPath: null,
      scriptPath: null,
    })
    expect(await fleetCodexUninstall()).toEqual({
      status: "unavailable",
      configPath: null,
      scriptPath: null,
    })
    expect(await fleetCodexHooksStatus()).toBe("unavailable")
    expect(await fleetCodexHooksInstall()).toBe("unavailable")
    expect(await fleetCodexHooksUninstall()).toBe("unavailable")
    expect(await fleetOpencodeStatus()).toEqual({ status: "unavailable", pluginPath: null })
    expect(await fleetOpencodeInstall()).toEqual({ status: "unavailable", pluginPath: null })
    expect(await fleetOpencodeUninstall()).toEqual({ status: "unavailable", pluginPath: null })
    expect(await fleetOpencodeSendMessage("s", "hi")).toBeNull()
    expect(await openIslandWindow()).toBe(false)
    expect(await closeIslandWindow()).toBe(false)
    expect(await isIslandWindowOpen()).toBe(false)
    expect(await islandResize(400, 44)).toBe(0)
    expect(await islandSetTucked(true)).toBe(false)
    expect(await fleetRevealTranscript("/x/t.jsonl")).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(revealMock).not.toHaveBeenCalled()
  })
})

describe("fleetRevealTranscript", () => {
  it("reveals the transcript path via the shared reveal helper", async () => {
    revealMock.mockResolvedValue(undefined)
    expect(await fleetRevealTranscript("/x/proj/abc.jsonl")).toBe(true)
    expect(revealMock).toHaveBeenCalledWith("/x/proj/abc.jsonl")
  })

  it("returns false for an empty path without revealing", async () => {
    expect(await fleetRevealTranscript(null)).toBe(false)
    expect(await fleetRevealTranscript("")).toBe(false)
    expect(await fleetRevealTranscript(undefined)).toBe(false)
    expect(revealMock).not.toHaveBeenCalled()
  })

  it("swallows a reveal failure (renderer-safe)", async () => {
    revealMock.mockRejectedValue(new Error("no file manager"))
    expect(await fleetRevealTranscript("/x/gone.jsonl")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe("on Tauri", () => {
  it("passes monitor lifecycle calls through", async () => {
    const status = { enabled: true, port: 7890, configPath: "/x/agent-monitor.json" }
    invokeMock.mockResolvedValue(status)
    expect(await fleetMonitorStart()).toEqual(status)
    expect(invokeMock).toHaveBeenCalledWith("fleet_monitor_start")
    expect(await fleetMonitorStatus()).toEqual(status)
    expect(invokeMock).toHaveBeenCalledWith("fleet_monitor_status")
    expect(await fleetMonitorRestore()).toEqual(status)
    expect(invokeMock).toHaveBeenCalledWith("fleet_monitor_restore")
  })

  it("passes permission responses with camelCase args", async () => {
    invokeMock.mockResolvedValue(true)
    expect(await fleetPermissionRespond("req-1", "deny")).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("fleet_permission_respond", {
      requestId: "req-1",
      behavior: "deny",
    })
  })

  it("passes question answers (per-question option indices) through", async () => {
    invokeMock.mockResolvedValue(true)
    expect(await fleetQuestionRespond("req-2", [[1], [0, 2]])).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("fleet_question_respond", {
      requestId: "req-2",
      selections: [[1], [0, 2]],
    })
  })

  it("passes Codex integration calls through", async () => {
    const status = { status: "installed", configPath: "/c", scriptPath: "/s" }
    invokeMock.mockResolvedValue(status)
    expect(await fleetCodexInstall()).toEqual(status)
    expect(invokeMock).toHaveBeenCalledWith("fleet_codex_install")
    expect(await fleetCodexUninstall()).toEqual(status)
    expect(invokeMock).toHaveBeenCalledWith("fleet_codex_uninstall")
    expect(await fleetCodexStatus()).toEqual(status)
    expect(invokeMock).toHaveBeenCalledWith("fleet_codex_status")
  })

  it("passes Codex hooks calls through", async () => {
    invokeMock.mockResolvedValue("installed")
    expect(await fleetCodexHooksInstall()).toBe("installed")
    expect(invokeMock).toHaveBeenCalledWith("fleet_codex_hooks_install")
    expect(await fleetCodexHooksUninstall()).toBe("installed")
    expect(invokeMock).toHaveBeenCalledWith("fleet_codex_hooks_uninstall")
    expect(await fleetCodexHooksStatus()).toBe("installed")
    expect(invokeMock).toHaveBeenCalledWith("fleet_codex_hooks_status")
  })

  it("surfaces the stale hooks state verbatim", async () => {
    // `stale` means our handler drifted — and because Codex keys hook trust by
    // content, that also means it is no longer trusted and will not fire. It
    // must never be flattened into "installed".
    invokeMock.mockResolvedValue("stale")
    expect(await fleetCodexHooksStatus()).toBe("stale")
  })

  it("swallows a Codex hooks status failure but lets install/uninstall throw", async () => {
    invokeMock.mockRejectedValue(new Error("boom"))
    expect(await fleetCodexHooksStatus()).toBe("unavailable")
    await expect(fleetCodexHooksInstall()).rejects.toThrow("boom")
    await expect(fleetCodexHooksUninstall()).rejects.toThrow("boom")
  })

  it("swallows a Codex status failure but lets install/uninstall throw", async () => {
    invokeMock.mockRejectedValue(new Error("boom"))
    // status is defensive (used in the render path) → swallow to unavailable.
    expect(await fleetCodexStatus()).toEqual({
      status: "unavailable",
      configPath: null,
      scriptPath: null,
    })
    // install/uninstall surface conflicts to the user → must reject.
    await expect(fleetCodexInstall()).rejects.toThrow("boom")
    await expect(fleetCodexUninstall()).rejects.toThrow("boom")
  })

  it("passes OpenCode integration calls through", async () => {
    const status = { status: "installed", pluginPath: "/p" }
    invokeMock.mockResolvedValue(status)
    expect(await fleetOpencodeInstall()).toEqual(status)
    expect(invokeMock).toHaveBeenCalledWith("fleet_opencode_install")
    expect(await fleetOpencodeUninstall()).toEqual(status)
    expect(invokeMock).toHaveBeenCalledWith("fleet_opencode_uninstall")
    expect(await fleetOpencodeStatus()).toEqual(status)
    expect(invokeMock).toHaveBeenCalledWith("fleet_opencode_status")
  })

  it("swallows an OpenCode status failure but lets install/uninstall throw", async () => {
    invokeMock.mockRejectedValue(new Error("boom"))
    expect(await fleetOpencodeStatus()).toEqual({ status: "unavailable", pluginPath: null })
    await expect(fleetOpencodeInstall()).rejects.toThrow("boom")
    await expect(fleetOpencodeUninstall()).rejects.toThrow("boom")
  })

  it("queues an OpenCode send-message and returns the command id", async () => {
    invokeMock.mockResolvedValue("cmd-9")
    expect(await fleetOpencodeSendMessage("oc-1", "continue")).toBe("cmd-9")
    expect(invokeMock).toHaveBeenCalledWith("fleet_opencode_send_message", {
      sessionId: "oc-1",
      text: "continue",
    })
    // Failure → null, not a throw (renderer-safe).
    invokeMock.mockRejectedValue(new Error("boom"))
    expect(await fleetOpencodeSendMessage("oc-1", "x")).toBeNull()
  })

  it("focuses a terminal by agent + session id", async () => {
    invokeMock.mockResolvedValue(undefined)
    expect(await fleetFocusTerminal("codex", "abc")).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("fleet_focus_terminal", {
      agent: "codex",
      sessionId: "abc",
    })
  })

  it("island window ops pass opts and sizes through", async () => {
    invokeMock.mockResolvedValue(undefined)
    expect(await openIslandWindow({ width: 500, height: 60 })).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("open_island_window", {
      opts: { width: 500, height: 60 },
    })
    expect(await openIslandWindow()).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("open_island_window", { opts: null })
    // island_resize answers with the display's top safe-area inset; anything
    // non-numeric (older backends, undefined) normalizes to 0.
    expect(await islandResize(640, 200)).toBe(0)
    expect(invokeMock).toHaveBeenCalledWith("island_resize", { width: 640, height: 200 })
    invokeMock.mockResolvedValueOnce(37)
    expect(await islandResize(420, 44)).toBe(37)
    invokeMock.mockResolvedValueOnce(-5)
    expect(await islandResize(420, 44)).toBe(0)
    invokeMock.mockResolvedValueOnce(undefined)
    expect(await closeIslandWindow()).toBe(true)
    invokeMock.mockResolvedValue(true)
    expect(await isIslandWindowOpen()).toBe(true)
  })

  it("mirrors the tuck state to the click-through toggle", async () => {
    invokeMock.mockResolvedValue(undefined)
    expect(await islandSetTucked(true)).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("island_set_tucked", { tucked: true })
    expect(await islandSetTucked(false)).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("island_set_tucked", { tucked: false })
  })

  it("lists monitors and persists the island display choice", async () => {
    const monitors = [
      { name: "Built-in", index: 0, isPrimary: true, selected: false, width: 1512, height: 982 },
    ]
    invokeMock.mockResolvedValueOnce(monitors)
    expect(await islandListMonitors()).toEqual(monitors)
    expect(invokeMock).toHaveBeenCalledWith("island_list_monitors")

    invokeMock.mockResolvedValueOnce(undefined)
    expect(await islandSetMonitor("DELL U2723QE")).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("island_set_monitor", { monitor: "DELL U2723QE" })
    invokeMock.mockResolvedValueOnce(undefined)
    expect(await islandSetMonitor(null)).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("island_set_monitor", { monitor: null })
  })

  it("swallows command failures with a warn", async () => {
    invokeMock.mockRejectedValue(new Error("boom"))
    expect(await fleetMonitorStart()).toBeNull()
    expect(await fleetMonitorStop()).toEqual({ enabled: false, port: null, configPath: null })
    expect(await fleetMonitorStatus()).toEqual({ enabled: false, port: null, configPath: null })
    expect(await fleetGetSnapshot()).toEqual({ sessions: [], generatedAt: 0 })
    expect(await fleetPermissionRespond("r", "allow")).toBe(false)
    expect(await fleetFocusTerminal("codex", "s")).toBe(false)
    expect(await openIslandWindow()).toBe(false)
    expect(await closeIslandWindow()).toBe(false)
    expect(await isIslandWindowOpen()).toBe(false)
    expect(await islandResize(1, 1)).toBe(0)
    expect(await islandSetTucked(true)).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })
})
