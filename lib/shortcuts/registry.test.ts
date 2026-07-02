import { useShortcutStore, __resetShortcutStoreForTesting } from "./registry"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  TAURI_EVENTS: {},
  onTauriEvent: () => Promise.resolve(() => {}),
}))
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(),
  setPref: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as {
  invoke: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPref, setPref } = require("@/lib/tauri/store") as {
  getPref: jest.Mock
  setPref: jest.Mock
}

afterEach(() => {
  invoke.mockReset()
  getPref.mockReset()
  setPref.mockReset()
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

  describe("custom-binding persistence (survives a Rust restart)", () => {
    it("bind persists a non-built-in id to the pref store", async () => {
      getPref.mockResolvedValueOnce(null) // no prior persisted map
      invoke.mockResolvedValueOnce(undefined) // shortcut_bind
      await useShortcutStore
        .getState()
        .bind({ id: "pet.toggle-window", chord: "Ctrl+Alt+P", scope: "global" })
      expect(setPref).toHaveBeenCalledWith("shortcuts.custom.v1", {
        "pet.toggle-window": "ctrl+alt+p",
      })
    })

    it("bind merges with an existing persisted map rather than overwriting it", async () => {
      getPref.mockResolvedValueOnce({ "other.id": "ctrl+1" })
      invoke.mockResolvedValueOnce(undefined)
      await useShortcutStore
        .getState()
        .bind({ id: "pet.toggle-window", chord: "Ctrl+2", scope: "global" })
      expect(setPref).toHaveBeenCalledWith("shortcuts.custom.v1", {
        "other.id": "ctrl+1",
        "pet.toggle-window": "ctrl+2",
      })
    })

    it("bind does NOT persist a built-in id — Rust reseeds those on boot", async () => {
      invoke.mockResolvedValueOnce(undefined)
      await useShortcutStore
        .getState()
        .bind({ id: "tray.show", chord: "Ctrl+Space", scope: "global" })
      expect(setPref).not.toHaveBeenCalled()
      expect(getPref).not.toHaveBeenCalled()
    })

    it("unbind removes a custom id from the persisted map", async () => {
      getPref.mockResolvedValueOnce({ "pet.toggle-window": "ctrl+alt+p", "other.id": "ctrl+1" })
      invoke.mockResolvedValueOnce(undefined) // shortcut_unbind
      await useShortcutStore.getState().unbind("pet.toggle-window")
      expect(setPref).toHaveBeenCalledWith("shortcuts.custom.v1", { "other.id": "ctrl+1" })
    })

    it("unbind does not touch the pref store for a built-in id", async () => {
      invoke.mockResolvedValueOnce(undefined)
      await useShortcutStore.getState().unbind("tray.show")
      expect(getPref).not.toHaveBeenCalled()
      expect(setPref).not.toHaveBeenCalled()
    })

    it("hydrate re-binds a persisted custom id that Rust doesn't report", async () => {
      invoke.mockResolvedValueOnce([{ id: "tray.show", chord: "ctrl+shift+space" }]) // shortcut_list
      getPref.mockResolvedValueOnce({ "pet.toggle-window": "ctrl+alt+p" })
      invoke.mockResolvedValueOnce(undefined) // shortcut_bind re-apply
      await useShortcutStore.getState().hydrate()
      expect(invoke).toHaveBeenCalledWith("shortcut_bind", {
        id: "pet.toggle-window",
        chord: "ctrl+alt+p",
      })
      expect(useShortcutStore.getState().bindings["pet.toggle-window"]).toBe("ctrl+alt+p")
    })

    it("hydrate skips re-binding when Rust already reports the id", async () => {
      invoke.mockResolvedValueOnce([{ id: "pet.toggle-window", chord: "ctrl+alt+p" }])
      getPref.mockResolvedValueOnce({ "pet.toggle-window": "ctrl+alt+p" })
      await useShortcutStore.getState().hydrate()
      expect(invoke).toHaveBeenCalledTimes(1) // only shortcut_list — no re-bind call
    })

    it("hydrate tolerates a re-bind failure without breaking the rest of hydration", async () => {
      invoke.mockResolvedValueOnce([])
      getPref.mockResolvedValueOnce({ "pet.toggle-window": "ctrl+alt+p" })
      invoke.mockRejectedValueOnce(new Error("os register failed"))
      await useShortcutStore.getState().hydrate()
      expect(useShortcutStore.getState().hydrated).toBe(true)
      expect(useShortcutStore.getState().bindings["pet.toggle-window"]).toBeUndefined()
    })
  })
})
