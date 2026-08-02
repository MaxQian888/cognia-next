jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn().mockResolvedValue(null),
  setPref: jest.fn().mockResolvedValue(undefined),
}))

import { getPref, setPref } from "@/lib/tauri/store"
import { DEFAULT_TRAY_PANEL_ACTIONS, TRAY_PANEL_ACTIONS_PREF } from "./defaults"
import { __resetTrayPanelStoreForTesting, reorderActions, useTrayPanelStore } from "./store"
import type { TrayPanelAction } from "./types"

const getPrefMock = getPref as jest.Mock
const setPrefMock = setPref as jest.Mock

const custom = (id: string, patch: Partial<TrayPanelAction> = {}): TrayPanelAction => ({
  id,
  label: id,
  fields: [],
  trigger: { kind: "manual" },
  effect: { kind: "native", action: "show" },
  ...patch,
})

beforeEach(() => {
  __resetTrayPanelStoreForTesting()
  getPrefMock.mockReset().mockResolvedValue(null)
  setPrefMock.mockReset().mockResolvedValue(undefined)
})

describe("hydrate", () => {
  it("falls back to the shipped catalogue when nothing is stored", async () => {
    await useTrayPanelStore.getState().hydrate()
    expect(useTrayPanelStore.getState().actions).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
    expect(useTrayPanelStore.getState().hydrated).toBe(true)
  })

  it("backfills built-ins missing from a stored list", async () => {
    getPrefMock.mockResolvedValue([custom("mine")])
    await useTrayPanelStore.getState().hydrate()
    const ids = useTrayPanelStore.getState().actions.map((a) => a.id)
    expect(ids).toContain("mine")
    expect(ids).toContain("trayPanel.delegate")
  })

  it("reads the versioned pref key", async () => {
    await useTrayPanelStore.getState().hydrate()
    expect(getPrefMock).toHaveBeenCalledWith(TRAY_PANEL_ACTIONS_PREF)
  })

  it("still marks itself hydrated when the store read throws", async () => {
    // A failed read must not leave the panel waiting forever on defaults.
    getPrefMock.mockRejectedValue(new Error("store unavailable"))
    await useTrayPanelStore.getState().hydrate()
    expect(useTrayPanelStore.getState().hydrated).toBe(true)
    expect(useTrayPanelStore.getState().actions).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
  })
})

describe("mutations", () => {
  it("persists on every write", () => {
    useTrayPanelStore.getState().setActions([custom("a")])
    expect(setPrefMock).toHaveBeenCalledWith(TRAY_PANEL_ACTIONS_PREF, [custom("a")])
  })

  it("upsert replaces an existing action in place", () => {
    useTrayPanelStore.getState().setActions([custom("a"), custom("b")])
    useTrayPanelStore.getState().upsertAction(custom("a", { label: "renamed" }))
    const actions = useTrayPanelStore.getState().actions
    expect(actions.map((x) => x.id)).toEqual(["a", "b"])
    expect(actions[0].label).toBe("renamed")
  })

  it("upsert appends an unknown action", () => {
    useTrayPanelStore.getState().setActions([custom("a")])
    useTrayPanelStore.getState().upsertAction(custom("c"))
    expect(useTrayPanelStore.getState().actions.map((x) => x.id)).toEqual(["a", "c"])
  })

  it("removes a custom action outright", () => {
    useTrayPanelStore.getState().setActions([custom("a"), custom("b")])
    useTrayPanelStore.getState().removeAction("a")
    expect(useTrayPanelStore.getState().actions.map((x) => x.id)).toEqual(["b"])
  })

  it("hides a built-in instead of deleting it", () => {
    // Deleting one would be undone by the next backfill and read as
    // "it came back on its own".
    useTrayPanelStore.getState().setActions([custom("a", { builtIn: true })])
    useTrayPanelStore.getState().removeAction("a")
    const actions = useTrayPanelStore.getState().actions
    expect(actions).toHaveLength(1)
    expect(actions[0].hidden).toBe(true)
  })

  it("moves an action and ignores a move off either end", () => {
    useTrayPanelStore.getState().setActions([custom("a"), custom("b")])
    useTrayPanelStore.getState().moveAction("b", -1)
    expect(useTrayPanelStore.getState().actions.map((x) => x.id)).toEqual(["b", "a"])
    useTrayPanelStore.getState().moveAction("b", -1)
    expect(useTrayPanelStore.getState().actions.map((x) => x.id)).toEqual(["b", "a"])
  })

  it("ignores a move for an unknown id", () => {
    useTrayPanelStore.getState().setActions([custom("a")])
    setPrefMock.mockClear()
    useTrayPanelStore.getState().moveAction("nope", 1)
    expect(setPrefMock).not.toHaveBeenCalled()
  })

  it("reset restores the shipped catalogue", () => {
    useTrayPanelStore.getState().setActions([custom("a")])
    useTrayPanelStore.getState().reset()
    expect(useTrayPanelStore.getState().actions).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
  })
})

describe("reorderActions", () => {
  const list = [custom("a"), custom("b"), custom("c")]

  it("swaps with the neighbour in the given direction", () => {
    expect(reorderActions(list, 1, -1).map((x) => x.id)).toEqual(["b", "a", "c"])
    expect(reorderActions(list, 1, 1).map((x) => x.id)).toEqual(["a", "c", "b"])
  })

  it("is a no-op at the ends and for an out-of-range index", () => {
    expect(reorderActions(list, 0, -1).map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(reorderActions(list, 2, 1).map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(reorderActions(list, 9, 1).map((x) => x.id)).toEqual(["a", "b", "c"])
  })

  it("never mutates the input", () => {
    const before = list.map((x) => x.id)
    reorderActions(list, 0, 1)
    expect(list.map((x) => x.id)).toEqual(before)
  })
})
