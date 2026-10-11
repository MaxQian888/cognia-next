/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { moveAction, removeAction, upsertAction } from "@/lib/tray-panel/catalogue"
import { DEFAULT_TRAY_PANEL_ACTIONS } from "@/lib/tray-panel/defaults"
import type { TrayPanelAction } from "@/lib/tray-panel/types"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { useTrayPanelActions } from "./use-tray-panel-actions"

const custom = (id: string, patch: Partial<TrayPanelAction> = {}): TrayPanelAction => ({
  id,
  label: id,
  fields: [],
  trigger: { kind: "manual" },
  effect: { kind: "navigate", path: "/x" },
  ...patch,
})

const ids = (actions: readonly TrayPanelAction[]) => actions.map((a) => a.id)

let save: jest.Mock

function seed(trayPanelActions?: unknown) {
  save = jest.fn().mockResolvedValue(undefined)
  useSettingsStore.setState({
    settings: (trayPanelActions === undefined ? {} : { trayPanelActions }) as never,
    save: save as never,
  })
}

describe("useTrayPanelActions", () => {
  beforeEach(() => seed())

  it("returns the shipped catalogue when nothing is stored", () => {
    const { result } = renderHook(() => useTrayPanelActions())
    expect(result.current.actions).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
  })

  it("returns the shipped catalogue while settings are not loaded", () => {
    useSettingsStore.setState({ settings: null as never })
    const { result } = renderHook(() => useTrayPanelActions())
    expect(result.current.actions).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
  })

  it("reads the stored catalogue through the resolver (built-ins backfilled)", () => {
    seed([custom("mine"), { id: "" }])
    const { result } = renderHook(() => useTrayPanelActions())
    expect(ids(result.current.actions)).toContain("mine")
    expect(ids(result.current.actions)).toContain("trayPanel.delegate")
    expect(ids(result.current.actions)).not.toContain("")
  })

  it("keeps the same list while the stored value is unchanged", () => {
    seed([custom("mine")])
    const { result, rerender } = renderHook(() => useTrayPanelActions())
    const first = result.current.actions
    rerender()
    expect(result.current.actions).toBe(first)
  })

  it("follows a settings change", () => {
    const { result } = renderHook(() => useTrayPanelActions())
    act(() => {
      useSettingsStore.setState({ settings: { trayPanelActions: [custom("later")] } as never })
    })
    expect(ids(result.current.actions)).toContain("later")
  })

  it("setActions saves the list whole", async () => {
    const { result } = renderHook(() => useTrayPanelActions())
    const next = [custom("a"), custom("b")]
    await act(async () => {
      await result.current.setActions(next)
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ trayPanelActions: next })
  })

  it("upsert saves the current list with the action appended", async () => {
    seed([custom("a")])
    const { result } = renderHook(() => useTrayPanelActions())
    const before = result.current.actions
    await act(async () => {
      await result.current.upsert(custom("new"))
    })
    expect(save).toHaveBeenCalledWith({ trayPanelActions: upsertAction(before, custom("new")) })
    expect(ids(save.mock.calls[0][0].trayPanelActions)).toContain("new")
  })

  it("upsert replaces an action with the same id in place", async () => {
    seed([custom("a")])
    const { result } = renderHook(() => useTrayPanelActions())
    await act(async () => {
      await result.current.upsert(custom("a", { label: "renamed" }))
    })
    const saved: TrayPanelAction[] = save.mock.calls[0][0].trayPanelActions
    expect(saved.filter((a) => a.id === "a")).toEqual([custom("a", { label: "renamed" })])
  })

  it("remove saves the list without a custom action", async () => {
    seed([custom("a"), custom("b")])
    const { result } = renderHook(() => useTrayPanelActions())
    const before = result.current.actions
    await act(async () => {
      await result.current.remove("a")
    })
    expect(save).toHaveBeenCalledWith({ trayPanelActions: removeAction(before, "a") })
    expect(ids(save.mock.calls[0][0].trayPanelActions)).not.toContain("a")
  })

  it("remove hides a built-in rather than dropping it", async () => {
    const { result } = renderHook(() => useTrayPanelActions())
    await act(async () => {
      await result.current.remove("trayPanel.openApp")
    })
    const saved: TrayPanelAction[] = save.mock.calls[0][0].trayPanelActions
    expect(saved.find((a) => a.id === "trayPanel.openApp")?.hidden).toBe(true)
    expect(saved).toHaveLength(DEFAULT_TRAY_PANEL_ACTIONS.length)
  })

  it("move saves the neighbour swap", async () => {
    seed([custom("a"), custom("b")])
    const { result } = renderHook(() => useTrayPanelActions())
    const before = result.current.actions
    await act(async () => {
      await result.current.move("b", -1)
    })
    expect(save).toHaveBeenCalledWith({ trayPanelActions: moveAction(before, "b", -1) })
    const saved: TrayPanelAction[] = save.mock.calls[0][0].trayPanelActions
    expect(ids(saved).indexOf("b")).toBeLessThan(ids(saved).indexOf("a"))
  })

  it("reset saves the shipped catalogue", async () => {
    seed([custom("a")])
    const { result } = renderHook(() => useTrayPanelActions())
    await act(async () => {
      await result.current.reset()
    })
    expect(save).toHaveBeenCalledWith({ trayPanelActions: DEFAULT_TRAY_PANEL_ACTIONS })
  })

  it("propagates a failed save to the caller", async () => {
    const { result } = renderHook(() => useTrayPanelActions())
    save.mockRejectedValue(new Error("disk full"))
    await expect(result.current.reset()).rejects.toThrow("disk full")
  })

  it("edits are based on the latest list after a settings change", async () => {
    const { result } = renderHook(() => useTrayPanelActions())
    act(() => {
      useSettingsStore.setState({ settings: { trayPanelActions: [custom("fresh")] } as never })
    })
    await act(async () => {
      await result.current.upsert(custom("x"))
    })
    expect(ids(save.mock.calls[0][0].trayPanelActions)).toEqual(
      expect.arrayContaining(["fresh", "x"])
    )
  })
})
