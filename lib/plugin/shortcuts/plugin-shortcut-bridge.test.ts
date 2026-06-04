/**
 * @jest-environment jsdom
 *
 * Tests for the plugin shortcut bridge: browser keydown fallback (chord
 * normalization, preventDefault, ref-counted listener), desktop bind via
 * the live shortcut rail (conflict skip, unbind on teardown), wrapper
 * command lifecycle, and per-plugin bulk teardown.
 */

import { fireEvent } from "@testing-library/dom"

import {
  __resetPluginShortcutBridgeForTesting,
  bindPluginShortcut,
  listPluginShortcuts,
  unbindAllPluginShortcuts,
} from "./plugin-shortcut-bridge"
import {
  __resetCommandRegistryForTesting,
  getCommand,
  registerCommand,
} from "@/lib/plugin/commands/registry"
import { useShortcutStore, __resetShortcutStoreForTesting } from "@/lib/shortcuts/registry"

const isTauriMock = jest.fn(() => false)
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: () => isTauriMock(),
}))

const recordSilentFailure = jest.fn()
jest.mock("@/lib/plugin/contracts/diagnostics-store", () => ({
  recordSilentFailure: (...args: unknown[]) => recordSilentFailure(...args),
}))

afterEach(() => {
  __resetPluginShortcutBridgeForTesting()
  __resetCommandRegistryForTesting()
  __resetShortcutStoreForTesting()
  isTauriMock.mockReset().mockReturnValue(false)
  recordSilentFailure.mockClear()
})

describe("browser fallback", () => {
  it("fires the handler on a matching (normalized) chord", async () => {
    const run = jest.fn()
    await bindPluginShortcut({ pluginId: "plug-a", chord: "Shift+Ctrl+Y", run })

    fireEvent.keyDown(window, { key: "y", ctrlKey: true, shiftKey: true })

    expect(run).toHaveBeenCalledTimes(1)
  })

  it("registers a hidden wrapper command as the dispatch handle", async () => {
    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+Y", run: () => {} })

    expect(getCommand("_pshortcut:plug-a:ctrl+y")).toBeDefined()
  })

  it("dispatches through an existing command id when provided", async () => {
    const handler = jest.fn()
    registerCommand({ id: "qa:plug-a:sync", pluginId: "plug-a", handler })
    await bindPluginShortcut({
      pluginId: "plug-a",
      chord: "Ctrl+U",
      existingCommandId: "qa:plug-a:sync",
    })

    fireEvent.keyDown(window, { key: "u", ctrlKey: true })

    expect(handler).toHaveBeenCalled()
    // No wrapper command was created for an existing id.
    expect(getCommand("_pshortcut:plug-a:ctrl+u")).toBeUndefined()
  })

  it("ignores non-matching chords", async () => {
    const run = jest.fn()
    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+Y", run })

    fireEvent.keyDown(window, { key: "y", altKey: true })

    expect(run).not.toHaveBeenCalled()
  })

  it("disposer removes the binding, the wrapper command, and (last one out) the listener", async () => {
    const run = jest.fn()
    const dispose = await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+Y", run })

    dispose()
    fireEvent.keyDown(window, { key: "y", ctrlKey: true })

    expect(run).not.toHaveBeenCalled()
    expect(getCommand("_pshortcut:plug-a:ctrl+y")).toBeUndefined()
    expect(listPluginShortcuts("plug-a")).toEqual([])
  })
})

describe("desktop rail", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
  })

  it("binds the chord through the shortcut store when free", async () => {
    const bind = jest.fn(async () => ({ ok: true }))
    const conflictFor = jest.fn(async () => null)
    useShortcutStore.setState({ bind, conflictFor } as never)

    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+Shift+P", run: () => {} })

    expect(conflictFor).toHaveBeenCalledWith("ctrl+shift+p", "_pshortcut:plug-a:ctrl+shift+p")
    expect(bind).toHaveBeenCalledWith({
      id: "_pshortcut:plug-a:ctrl+shift+p",
      chord: "ctrl+shift+p",
      scope: "global",
    })
  })

  it("never overrides an existing chord — skips the OS bind and records a silent failure", async () => {
    const bind = jest.fn(async () => ({ ok: true }))
    const conflictFor = jest.fn(async () => "user.binding")
    useShortcutStore.setState({ bind, conflictFor } as never)

    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+K", run: () => {} })

    expect(bind).not.toHaveBeenCalled()
    expect(recordSilentFailure).toHaveBeenCalledWith(
      "plug-a",
      expect.objectContaining({ site: "shortcuts.bind", expected: true }),
      null
    )
    // The dispatch command still exists — reachable via palette/tray.
    expect(getCommand("_pshortcut:plug-a:ctrl+k")).toBeDefined()
  })

  it("unbinds the OS chord on teardown", async () => {
    const bind = jest.fn(async () => ({ ok: true }))
    const conflictFor = jest.fn(async () => null)
    const unbind = jest.fn(async () => {})
    useShortcutStore.setState({ bind, conflictFor, unbind } as never)

    const dispose = await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+P", run: () => {} })
    dispose()

    expect(unbind).toHaveBeenCalledWith("_pshortcut:plug-a:ctrl+p")
  })

  it("records a silent failure when the bind itself fails", async () => {
    const bind = jest.fn(async () => ({ ok: false, error: "RegisterHotKey failed" }))
    const conflictFor = jest.fn(async () => null)
    useShortcutStore.setState({ bind, conflictFor } as never)

    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+J", run: () => {} })

    expect(recordSilentFailure).toHaveBeenCalledWith(
      "plug-a",
      expect.objectContaining({ site: "shortcuts.bind", expected: false }),
      "RegisterHotKey failed"
    )
  })
})

describe("unbindAllPluginShortcuts", () => {
  it("drops every binding owned by the plugin and leaves others intact", async () => {
    const runA = jest.fn()
    const runB = jest.fn()
    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+1", run: runA })
    await bindPluginShortcut({ pluginId: "plug-b", chord: "Ctrl+2", run: runB })

    const removed = unbindAllPluginShortcuts("plug-a")

    expect(removed).toBe(1)
    fireEvent.keyDown(window, { key: "1", ctrlKey: true })
    fireEvent.keyDown(window, { key: "2", ctrlKey: true })
    expect(runA).not.toHaveBeenCalled()
    expect(runB).toHaveBeenCalled()
  })
})
