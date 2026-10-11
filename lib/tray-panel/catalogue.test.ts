import { DEFAULT_TRAY_PANEL_ACTIONS, BUILT_IN_ACTION_IDS } from "./defaults"
import {
  isTrayPanelActionShape,
  moveAction,
  removeAction,
  reorderActions,
  resolveTrayPanelActions,
  TRAY_PANEL_ACTIONS_MAX,
  upsertAction,
} from "./catalogue"
import type { TrayPanelAction } from "./types"

const custom = (id: string, patch: Partial<TrayPanelAction> = {}): TrayPanelAction => ({
  id,
  label: id,
  fields: [],
  trigger: { kind: "manual" },
  effect: { kind: "native", action: "show" },
  ...patch,
})

const ids = (actions: readonly TrayPanelAction[]) => actions.map((a) => a.id)

describe("isTrayPanelActionShape", () => {
  it("accepts a minimal action and every shipped default", () => {
    expect(isTrayPanelActionShape(custom("a"))).toBe(true)
    for (const action of DEFAULT_TRAY_PANEL_ACTIONS) {
      expect(isTrayPanelActionShape(action)).toBe(true)
    }
  })

  it.each([[null], [undefined], ["a"], [1], [true], [[]], [[custom("a")]]])(
    "rejects non-object %j",
    (value) => {
      expect(isTrayPanelActionShape(value)).toBe(false)
    }
  )

  it("rejects an id of length 0 or over 200, accepts 1 and 200", () => {
    expect(isTrayPanelActionShape(custom(""))).toBe(false)
    expect(isTrayPanelActionShape(custom("x".repeat(201)))).toBe(false)
    expect(isTrayPanelActionShape(custom("x"))).toBe(true)
    expect(isTrayPanelActionShape(custom("x".repeat(200)))).toBe(true)
    expect(isTrayPanelActionShape({ ...custom("a"), id: 7 })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), id: undefined })).toBe(false)
  })

  it("rejects a non-string label", () => {
    expect(isTrayPanelActionShape({ ...custom("a"), label: 3 })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), label: undefined })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), label: "" })).toBe(true)
  })

  it("rejects non-array fields", () => {
    expect(isTrayPanelActionShape({ ...custom("a"), fields: undefined })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), fields: {} })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), fields: "text" })).toBe(false)
  })

  it("rejects a malformed field or an unknown field kind", () => {
    const withField = (field: unknown) => ({ ...custom("a"), fields: [field] })
    expect(isTrayPanelActionShape(withField(null))).toBe(false)
    expect(isTrayPanelActionShape(withField("text"))).toBe(false)
    expect(isTrayPanelActionShape(withField({ kind: "text" }))).toBe(false)
    expect(isTrayPanelActionShape(withField({ id: 1, kind: "text" }))).toBe(false)
    expect(isTrayPanelActionShape(withField({ id: "f", kind: "color" }))).toBe(false)
    expect(isTrayPanelActionShape(withField({ id: "f" }))).toBe(false)
  })

  it.each(["text", "textarea", "switch", "number"])("accepts a %s field", (kind) => {
    expect(
      isTrayPanelActionShape({ ...custom("a"), fields: [{ id: "f", kind, label: "F" }] })
    ).toBe(true)
  })

  it("requires a select field to carry an options array", () => {
    const select = (extra: Record<string, unknown>) => ({
      ...custom("a"),
      fields: [{ id: "f", kind: "select", label: "F", ...extra }],
    })
    expect(isTrayPanelActionShape(select({}))).toBe(false)
    expect(isTrayPanelActionShape(select({ options: "a,b" }))).toBe(false)
    expect(isTrayPanelActionShape(select({ options: {} }))).toBe(false)
    expect(isTrayPanelActionShape(select({ options: [] }))).toBe(true)
    expect(isTrayPanelActionShape(select({ options: [{ value: "a", label: "A" }] }))).toBe(true)
  })

  it("rejects a missing, non-object or unknown effect", () => {
    expect(isTrayPanelActionShape({ ...custom("a"), effect: undefined })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), effect: "native" })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), effect: [] })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), effect: { kind: "teleport" } })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), effect: {} })).toBe(false)
  })

  it.each(["delegate", "slash", "command", "native", "navigate"])("accepts a %s effect", (kind) => {
    expect(isTrayPanelActionShape({ ...custom("a"), effect: { kind } })).toBe(true)
  })

  it("rejects a missing, non-object or unknown trigger", () => {
    expect(isTrayPanelActionShape({ ...custom("a"), trigger: undefined })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), trigger: "manual" })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), trigger: { kind: "schedule" } })).toBe(false)
  })

  it.each(["manual", "submit", "open"])("accepts a %s trigger", (kind) => {
    expect(isTrayPanelActionShape({ ...custom("a"), trigger: { kind } })).toBe(true)
  })

  it("requires a hotkey trigger to carry a chord string", () => {
    expect(isTrayPanelActionShape({ ...custom("a"), trigger: { kind: "hotkey" } })).toBe(false)
    expect(isTrayPanelActionShape({ ...custom("a"), trigger: { kind: "hotkey", chord: 1 } })).toBe(
      false
    )
    expect(
      isTrayPanelActionShape({ ...custom("a"), trigger: { kind: "hotkey", chord: "mod+1" } })
    ).toBe(true)
  })
})

describe("resolveTrayPanelActions", () => {
  it.each([[undefined], [null], ["x"], [3], [{}], [[]]])(
    "falls back to the shipped catalogue for %j",
    (stored) => {
      expect(resolveTrayPanelActions(stored)).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
    }
  )

  it("keeps a valid stored list and backfills built-ins this build added", () => {
    const out = resolveTrayPanelActions([custom("mine")])
    expect(ids(out)).toContain("mine")
    for (const id of BUILT_IN_ACTION_IDS) expect(ids(out)).toContain(id)
    expect(out.find((a) => a.id === "mine")).toEqual(custom("mine"))
  })

  it("does not backfill a built-in the user hid, and keeps it hidden", () => {
    const hiddenDefault = { ...DEFAULT_TRAY_PANEL_ACTIONS[1], hidden: true }
    const out = resolveTrayPanelActions([DEFAULT_TRAY_PANEL_ACTIONS[0], hiddenDefault])
    expect(out.filter((a) => a.id === hiddenDefault.id)).toEqual([hiddenDefault])
  })

  it("drops malformed entries", () => {
    const out = resolveTrayPanelActions([
      custom("ok"),
      null,
      "junk",
      { id: "", label: "x" },
      { ...custom("badtrigger"), trigger: { kind: "schedule" } },
    ])
    expect(ids(out)).toContain("ok")
    expect(ids(out)).not.toContain("badtrigger")
    expect(ids(out)).not.toContain("")
  })

  it("drops duplicate ids, keeping the first", () => {
    const out = resolveTrayPanelActions([
      custom("dup", { label: "first" }),
      custom("dup", { label: "second" }),
    ])
    const dups = out.filter((a) => a.id === "dup")
    expect(dups).toHaveLength(1)
    expect(dups[0].label).toBe("first")
  })

  it("caps the list at TRAY_PANEL_ACTIONS_MAX before backfilling", () => {
    const many = Array.from({ length: TRAY_PANEL_ACTIONS_MAX + 20 }, (_, i) => custom(`a${i}`))
    const out = resolveTrayPanelActions(many)
    expect(ids(out)).toContain(`a${TRAY_PANEL_ACTIONS_MAX - 1}`)
    expect(ids(out)).not.toContain(`a${TRAY_PANEL_ACTIONS_MAX}`)
    expect(out.filter((a) => !a.builtIn)).toHaveLength(TRAY_PANEL_ACTIONS_MAX)
  })

  it("falls back to the shipped catalogue when every entry is invalid", () => {
    expect(resolveTrayPanelActions([null, "x", { id: "" }, 3])).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
  })

  it("migrates a retired native effect to its replacement command", () => {
    const out = resolveTrayPanelActions([
      custom("mine.pet", {
        effect: { kind: "native", action: "pet-toggle" } as unknown as TrayPanelAction["effect"],
      }),
    ])
    expect(out.find((a) => a.id === "mine.pet")?.effect).toEqual({
      kind: "command",
      commandId: "pet.toggle-window",
    })
    expect(ids(out)).toContain("trayPanel.delegate")
  })

  it("leaves a live native effect alone", () => {
    const out = resolveTrayPanelActions([custom("mine")])
    expect(out.find((a) => a.id === "mine")?.effect).toEqual({ kind: "native", action: "show" })
  })
})

describe("reorderActions", () => {
  const list = [custom("a"), custom("b"), custom("c")]

  it("swaps with the neighbour in the given direction", () => {
    expect(ids(reorderActions(list, 1, -1))).toEqual(["b", "a", "c"])
    expect(ids(reorderActions(list, 1, 1))).toEqual(["a", "c", "b"])
  })

  it("is a no-op at the ends and for an out-of-range index", () => {
    expect(ids(reorderActions(list, 0, -1))).toEqual(["a", "b", "c"])
    expect(ids(reorderActions(list, 2, 1))).toEqual(["a", "b", "c"])
    expect(ids(reorderActions(list, 9, 1))).toEqual(["a", "b", "c"])
    expect(ids(reorderActions(list, -1, 1))).toEqual(["a", "b", "c"])
  })

  it("never mutates the input and always returns a copy", () => {
    const before = ids(list)
    const swapped = reorderActions(list, 0, 1)
    const same = reorderActions(list, 0, -1)
    expect(ids(list)).toEqual(before)
    expect(swapped).not.toBe(list)
    expect(same).not.toBe(list)
  })
})

describe("upsertAction", () => {
  it("replaces an existing action in place", () => {
    const out = upsertAction([custom("a"), custom("b")], custom("a", { label: "renamed" }))
    expect(ids(out)).toEqual(["a", "b"])
    expect(out[0].label).toBe("renamed")
  })

  it("appends an unknown action", () => {
    expect(ids(upsertAction([custom("a")], custom("c")))).toEqual(["a", "c"])
  })

  it("does not mutate the input", () => {
    const list = [custom("a")]
    upsertAction(list, custom("a", { label: "x" }))
    upsertAction(list, custom("z"))
    expect(list).toEqual([custom("a")])
  })
})

describe("removeAction", () => {
  it("removes a custom action outright", () => {
    expect(ids(removeAction([custom("a"), custom("b")], "a"))).toEqual(["b"])
  })

  it("hides a built-in instead of deleting it", () => {
    // Deleting one would be undone by the next backfill and read as
    // "it came back on its own".
    const out = removeAction([custom("a", { builtIn: true })], "a")
    expect(out).toHaveLength(1)
    expect(out[0].hidden).toBe(true)
  })

  it("leaves other actions untouched, including other built-ins", () => {
    const list = [custom("a", { builtIn: true }), custom("b", { builtIn: true }), custom("c")]
    const out = removeAction(list, "a")
    expect(out[1]).toBe(list[1])
    expect(out[2]).toBe(list[2])
  })

  it("is a no-op for an unknown id and never mutates the input", () => {
    const list = [custom("a", { builtIn: true })]
    expect(removeAction(list, "nope")).toEqual(list)
    removeAction(list, "a")
    expect(list[0].hidden).toBeUndefined()
  })
})

describe("moveAction", () => {
  it("moves an action and ignores a move off either end", () => {
    const list = [custom("a"), custom("b")]
    const up = moveAction(list, "b", -1)
    expect(ids(up)).toEqual(["b", "a"])
    expect(ids(moveAction(up, "b", -1))).toEqual(["b", "a"])
    expect(ids(moveAction(up, "a", 1))).toEqual(["b", "a"])
  })

  it("is a no-op for an unknown id", () => {
    expect(ids(moveAction([custom("a"), custom("b")], "nope", 1))).toEqual(["a", "b"])
    expect(ids(moveAction([custom("a"), custom("b")], "nope", -1))).toEqual(["a", "b"])
  })
})
