import { useShortcutStore, __resetShortcutStoreForTesting } from "./registry"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  TAURI_EVENTS: {},
  onTauriEvent: () => Promise.resolve(() => {}),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as {
  invoke: jest.Mock
}

afterEach(() => {
  invoke.mockReset()
  __resetShortcutStoreForTesting()
})

describe("useShortcutStore", () => {
  it("hydrate populates bindings from the Rust shortcut_list response", async () => {
    invoke.mockResolvedValueOnce([
      { id: "tray.show", chord: "ctrl+shift+space" },
      { id: "tray.open-logs", chord: "ctrl+shift+l" },
    ])
    await useShortcutStore.getState().hydrate()
    const { bindings, hydrated } = useShortcutStore.getState()
    expect(hydrated).toBe(true)
    expect(bindings["tray.show"]).toBe("ctrl+shift+space")
    expect(bindings["tray.open-logs"]).toBe("ctrl+shift+l")
  })

  it("hydrate tolerates IPC failure by marking hydrated with empty bindings", async () => {
    invoke.mockRejectedValueOnce(new Error("boom"))
    await useShortcutStore.getState().hydrate()
    expect(useShortcutStore.getState().hydrated).toBe(true)
    expect(useShortcutStore.getState().bindings).toEqual({})
  })

  it("bind normalises the chord before invoking and updates the store on success", async () => {
    invoke.mockResolvedValueOnce(undefined)
    const result = await useShortcutStore
      .getState()
      .bind({ id: "tray.show", chord: "Shift+Ctrl+Space", scope: "global" })
    expect(invoke).toHaveBeenCalledWith("shortcut_bind", {
      id: "tray.show",
      chord: "ctrl+shift+space",
    })
    expect(result).toEqual({ ok: true })
    expect(useShortcutStore.getState().bindings["tray.show"]).toBe("ctrl+shift+space")
  })

  it("bind reports failure without mutating the store on IPC reject", async () => {
    invoke.mockRejectedValueOnce(new Error("conflict"))
    const result = await useShortcutStore
      .getState()
      .bind({ id: "tray.show", chord: "Ctrl+Space", scope: "global" })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/conflict/)
    expect(useShortcutStore.getState().bindings["tray.show"]).toBeUndefined()
  })

  it("unbind removes the id and recomputes conflicts", async () => {
    invoke.mockResolvedValueOnce(undefined)
    await useShortcutStore
      .getState()
      .bind({ id: "tray.show", chord: "Ctrl+Space", scope: "global" })
    invoke.mockResolvedValueOnce(undefined)
    await useShortcutStore.getState().unbind("tray.show")
    expect(invoke).toHaveBeenCalledWith("shortcut_unbind", { id: "tray.show" })
    expect(useShortcutStore.getState().bindings["tray.show"]).toBeUndefined()
  })

  it("conflictFor passes the normalized chord and ignoring id through to IPC", async () => {
    invoke.mockResolvedValueOnce("tray.show")
    const owner = await useShortcutStore.getState().conflictFor("Ctrl+Shift+Space", "tray.show")
    expect(invoke).toHaveBeenCalledWith("shortcut_check_conflict", {
      chord: "ctrl+shift+space",
      ignoringId: "tray.show",
    })
    expect(owner).toBe("tray.show")
  })

  it("chordFor returns the cached chord without an IPC call after hydrate", async () => {
    invoke.mockResolvedValueOnce([{ id: "tray.show", chord: "ctrl+shift+space" }])
    await useShortcutStore.getState().hydrate()
    invoke.mockClear()
    const chord = await useShortcutStore.getState().chordFor("tray.show")
    expect(chord).toBe("ctrl+shift+space")
    expect(invoke).not.toHaveBeenCalled()
  })

  it("chordFor falls back to shortcut_get_chord_for_id when the cache is empty", async () => {
    invoke.mockResolvedValueOnce("ctrl+alt+k")
    const chord = await useShortcutStore.getState().chordFor("tray.automation-kill")
    expect(invoke).toHaveBeenCalledWith("shortcut_get_chord_for_id", {
      id: "tray.automation-kill",
    })
    expect(chord).toBe("ctrl+alt+k")
  })

  it("chordFor returns null when the Rust side reports no binding", async () => {
    invoke.mockResolvedValueOnce(null)
    const chord = await useShortcutStore.getState().chordFor("unknown.id")
    expect(chord).toBeNull()
  })

  it("chordFor swallows IPC errors and returns null", async () => {
    invoke.mockRejectedValueOnce(new Error("ipc down"))
    const chord = await useShortcutStore.getState().chordFor("tray.show")
    expect(chord).toBeNull()
  })
})
