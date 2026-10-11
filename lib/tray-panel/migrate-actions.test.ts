import { TRAY_PANEL_ACTIONS_PREF } from "./defaults"
import { migrateTrayPanelActions, type MigrateTrayPanelActionsDeps } from "./migrate-actions"
import type { TrayPanelAction } from "./types"

const action = (id: string): TrayPanelAction => ({
  id,
  label: id,
  fields: [],
  trigger: { kind: "manual" },
  effect: { kind: "navigate", path: "/x" },
})

function setup(stored: unknown, current: TrayPanelAction[] | undefined = undefined) {
  const readPref = jest.fn<Promise<unknown>, [string]>().mockResolvedValue(stored)
  const deletePref = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined)
  const save = jest.fn<Promise<void>, [TrayPanelAction[]]>().mockResolvedValue(undefined)
  const deps: MigrateTrayPanelActionsDeps = { current, readPref, deletePref, save }
  return { deps, readPref, deletePref, save }
}

describe("migrateTrayPanelActions", () => {
  it("reads the retired pref key", async () => {
    const { deps, readPref } = setup(null)
    await migrateTrayPanelActions(deps)
    expect(readPref).toHaveBeenCalledTimes(1)
    expect(readPref).toHaveBeenCalledWith(TRAY_PANEL_ACTIONS_PREF)
    expect(TRAY_PANEL_ACTIONS_PREF).toBe("trayPanel.actions.v1")
  })

  it.each([[null], [undefined]])("does nothing when there is no pref (%s)", async (stored) => {
    const { deps, save, deletePref } = setup(stored)
    await expect(migrateTrayPanelActions(deps)).resolves.toBe("nothing")
    expect(save).not.toHaveBeenCalled()
    expect(deletePref).not.toHaveBeenCalled()
  })

  it("does nothing for an absent pref even when settings hold a catalogue", async () => {
    const { deps, save, deletePref } = setup(null, [action("synced")])
    await expect(migrateTrayPanelActions(deps)).resolves.toBe("nothing")
    expect(save).not.toHaveBeenCalled()
    expect(deletePref).not.toHaveBeenCalled()
  })

  it("keeps the catalogue settings already have and drops the pref", async () => {
    const { deps, save, deletePref } = setup([action("old")], [action("synced")])
    await expect(migrateTrayPanelActions(deps)).resolves.toBe("kept-settings")
    expect(save).not.toHaveBeenCalled()
    expect(deletePref).toHaveBeenCalledTimes(1)
    expect(deletePref).toHaveBeenCalledWith(TRAY_PANEL_ACTIONS_PREF)
  })

  it("treats an empty catalogue in settings as one that exists", async () => {
    const { deps, save, deletePref } = setup([action("old")], [])
    await expect(migrateTrayPanelActions(deps)).resolves.toBe("kept-settings")
    expect(save).not.toHaveBeenCalled()
    expect(deletePref).toHaveBeenCalledTimes(1)
  })

  it("imports a non-empty stored array as-is, saving before it deletes", async () => {
    const stored = [action("a"), action("b")]
    const { deps, save, deletePref } = setup(stored)
    await expect(migrateTrayPanelActions(deps)).resolves.toBe("imported")
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(stored)
    expect(save.mock.calls[0][0]).toBe(stored)
    expect(deletePref).toHaveBeenCalledTimes(1)
    expect(deletePref).toHaveBeenCalledWith(TRAY_PANEL_ACTIONS_PREF)
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(deletePref.mock.invocationCallOrder[0])
  })

  it("does not repair a malformed stored entry; reads repair it later", async () => {
    const stored = [action("a"), { id: "" }, "junk"]
    const { deps, save } = setup(stored)
    await expect(migrateTrayPanelActions(deps)).resolves.toBe("imported")
    expect(save).toHaveBeenCalledWith(stored)
  })

  it("drops an empty pref array without saving", async () => {
    const { deps, save, deletePref } = setup([])
    await expect(migrateTrayPanelActions(deps)).resolves.toBe("nothing")
    expect(save).not.toHaveBeenCalled()
    expect(deletePref).toHaveBeenCalledWith(TRAY_PANEL_ACTIONS_PREF)
  })

  it.each([["text"], [3], [{ id: "a" }], [true]])(
    "drops an unreadable pref (%j) without saving",
    async (stored) => {
      const { deps, save, deletePref } = setup(stored)
      await expect(migrateTrayPanelActions(deps)).resolves.toBe("nothing")
      expect(save).not.toHaveBeenCalled()
      expect(deletePref).toHaveBeenCalledTimes(1)
    }
  )

  it("rejects and keeps the pref when the save fails, so the next launch retries", async () => {
    const { deps, save, deletePref } = setup([action("a")])
    save.mockRejectedValue(new Error("disk full"))
    await expect(migrateTrayPanelActions(deps)).rejects.toThrow("disk full")
    expect(deletePref).not.toHaveBeenCalled()
  })

  it("rejects when the pref cannot be read", async () => {
    const { deps, readPref, save, deletePref } = setup(null)
    readPref.mockRejectedValue(new Error("store unavailable"))
    await expect(migrateTrayPanelActions(deps)).rejects.toThrow("store unavailable")
    expect(save).not.toHaveBeenCalled()
    expect(deletePref).not.toHaveBeenCalled()
  })

  it("propagates a failed delete after a successful import", async () => {
    const { deps, save, deletePref } = setup([action("a")])
    deletePref.mockRejectedValue(new Error("locked"))
    await expect(migrateTrayPanelActions(deps)).rejects.toThrow("locked")
    // The catalogue is already safe in settings; the next run sees it and
    // takes the kept-settings branch.
    expect(save).toHaveBeenCalledTimes(1)
  })
})
