/**
 * @jest-environment jsdom
 */
import { DOCK_PRESET_LIMIT_PER_HOST, useDockPresetStore } from "./dock-preset-store"
import type { DockPreset } from "@/types/dock/preset"

const format = (name: string, count: number) => `${name} (${count})`

function preset(overrides: Partial<DockPreset> = {}): DockPreset {
  return {
    id: "p1",
    name: "Review",
    host: "chat",
    schemaVersion: 1,
    root: { type: "group", panels: [{ panelId: "review", mode: "pinned" }] },
    shell: { edge: "right", sizePercent: 34 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const store = () => useDockPresetStore.getState()

beforeEach(() => {
  useDockPresetStore.setState({ presets: {}, defaults: {} })
})

describe("savePreset", () => {
  it("stores a preset and returns what was actually stored", () => {
    const stored = store().savePreset(preset(), format)
    expect(stored?.name).toBe("Review")
    expect(store().getPreset("p1")).toEqual(stored)
  })

  it("renames rather than overwriting a name the host already uses", () => {
    store().savePreset(preset(), format)
    const second = store().savePreset(preset({ id: "p2" }), format)
    expect(second?.name).toBe("Review (2)")
    expect(store().getPreset("p1")?.name).toBe("Review")
  })

  it("lets the same name live in two different hosts", () => {
    store().savePreset(preset(), format)
    const other = store().savePreset(preset({ id: "p2", host: "project" }), format)
    expect(other?.name).toBe("Review")
  })

  it("updating an existing preset does not rename it against itself", () => {
    store().savePreset(preset(), format)
    const updated = store().savePreset(preset({ name: "Review", updatedAt: 9 }), format)
    expect(updated?.name).toBe("Review")
    expect(store().listPresets("chat")).toHaveLength(1)
  })

  it("refuses a new preset once the host is at its limit", () => {
    for (let i = 0; i < DOCK_PRESET_LIMIT_PER_HOST; i += 1) {
      store().savePreset(preset({ id: `p${i}`, name: `Layout ${i}` }), format)
    }
    expect(store().savePreset(preset({ id: "overflow", name: "One more" }), format)).toBeNull()
    // Updating one that already exists still works at the limit.
    expect(store().savePreset(preset({ id: "p0", name: "Layout 0" }), format)).not.toBeNull()
  })
})

describe("listPresets", () => {
  it("puts built-ins first, then the most recently updated", () => {
    store().savePreset(
      preset({ id: "shipped", name: "Empty", builtin: true, updatedAt: 1 }),
      format
    )
    store().savePreset(preset({ id: "old", name: "Old", updatedAt: 10 }), format)
    store().savePreset(preset({ id: "new", name: "New", updatedAt: 20 }), format)
    expect(
      store()
        .listPresets("chat")
        .map((p) => p.id)
    ).toEqual(["shipped", "new", "old"])

    // …and the same regardless of the order they were stored in.
    useDockPresetStore.setState({ presets: {}, defaults: {} })
    store().savePreset(preset({ id: "old", name: "Old", updatedAt: 10 }), format)
    store().savePreset(
      preset({ id: "shipped", name: "Empty", builtin: true, updatedAt: 1 }),
      format
    )
    expect(
      store()
        .listPresets("chat")
        .map((p) => p.id)
    ).toEqual(["shipped", "old"])
  })

  it("only lists the host asked for", () => {
    store().savePreset(preset({ id: "a" }), format)
    store().savePreset(preset({ id: "b", host: "canvas" }), format)
    expect(
      store()
        .listPresets("canvas")
        .map((p) => p.id)
    ).toEqual(["b"])
    expect(store().listPresets("workflow")).toEqual([])
  })
})

describe("renamePreset", () => {
  it("renames a user preset and stamps it", () => {
    store().savePreset(preset(), format)
    expect(store().renamePreset("p1", "  Renamed  ", format)).toBe(true)
    expect(store().getPreset("p1")?.name).toBe("Renamed")
    expect(store().getPreset("p1")?.updatedAt).toBeGreaterThan(1)
  })

  it("suffixes a rename that collides with a sibling", () => {
    store().savePreset(preset({ id: "a", name: "A" }), format)
    store().savePreset(preset({ id: "b", name: "B" }), format)
    store().renamePreset("b", "A", format)
    expect(store().getPreset("b")?.name).toBe("A (2)")
  })

  it("refuses an empty name, an unknown preset, and a built-in", () => {
    // A built-in is a fixed starting point the docs and the reset command name.
    store().savePreset(preset(), format)
    store().savePreset(preset({ id: "shipped", name: "Empty", builtin: true }), format)
    expect(store().renamePreset("p1", "   ", format)).toBe(false)
    expect(store().renamePreset("missing", "X", format)).toBe(false)
    expect(store().renamePreset("shipped", "X", format)).toBe(false)
    expect(store().getPreset("shipped")?.name).toBe("Empty")
  })
})

describe("deletePreset", () => {
  it("removes a user preset", () => {
    store().savePreset(preset(), format)
    expect(store().deletePreset("p1")).toBe(true)
    expect(store().getPreset("p1")).toBeUndefined()
  })

  it("refuses an unknown preset and a built-in", () => {
    store().savePreset(preset({ id: "shipped", builtin: true }), format)
    expect(store().deletePreset("missing")).toBe(false)
    expect(store().deletePreset("shipped")).toBe(false)
  })

  it("clears the host default rather than promoting a neighbour", () => {
    store().savePreset(preset({ id: "a", name: "A" }), format)
    store().savePreset(preset({ id: "b", name: "B" }), format)
    store().setDefaultPreset("chat", "a")
    store().deletePreset("a")
    expect(store().getDefaultPreset("chat")).toBeUndefined()
  })

  it("leaves another host's default alone", () => {
    store().savePreset(preset({ id: "a" }), format)
    store().savePreset(preset({ id: "b", host: "canvas", name: "B" }), format)
    store().setDefaultPreset("canvas", "b")
    store().deletePreset("a")
    expect(store().getDefaultPreset("canvas")?.id).toBe("b")
  })
})

describe("setDefaultPreset", () => {
  it("sets and clears the default for a host", () => {
    store().savePreset(preset(), format)
    expect(store().setDefaultPreset("chat", "p1")).toBe(true)
    expect(store().getDefaultPreset("chat")?.id).toBe("p1")
    expect(store().setDefaultPreset("chat", null)).toBe(true)
    expect(store().getDefaultPreset("chat")).toBeUndefined()
  })

  it("refuses a preset that does not exist or belongs to another host", () => {
    store().savePreset(preset({ id: "a", host: "canvas" }), format)
    expect(store().setDefaultPreset("chat", "missing")).toBe(false)
    expect(store().setDefaultPreset("chat", "a")).toBe(false)
    expect(store().getDefaultPreset("chat")).toBeUndefined()
  })
})

describe("persistence boundary", () => {
  it("persists presets and defaults, and nothing else", () => {
    const options = (
      useDockPresetStore as unknown as {
        persist: { getOptions: () => { partialize: (s: unknown) => Record<string, unknown> } }
      }
    ).persist.getOptions()
    store().savePreset(preset(), format)
    expect(Object.keys(options.partialize(useDockPresetStore.getState())).sort()).toEqual([
      "defaults",
      "presets",
    ])
  })
})
