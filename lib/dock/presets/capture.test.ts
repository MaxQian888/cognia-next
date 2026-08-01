import { applyDockPreset, captureDockPreset, createEmptyDockPreset } from "./capture"
import { sanitizeDockGrid } from "../sanitize-grid"
import { DEFAULT_DOCK_SHELL_STATE, DOCK_LAYOUT_SCHEMA_VERSION } from "@/types/dock/layout"
import type { DockLayoutEnvelope } from "@/types/dock/layout"
import type { DockPanelInstance } from "@/types/dock/instance"
import type { DockPreset } from "@/types/dock/preset"

function instance(
  id: string,
  panelId: string,
  mode: "preview" | "pinned" = "pinned"
): DockPanelInstance {
  return { instanceId: id, panelId, kind: "panel", mode, dirty: false, activated: true }
}

function envelope(
  instances: DockPanelInstance[],
  root: unknown,
  orientation: "HORIZONTAL" | "VERTICAL" = "HORIZONTAL"
): DockLayoutEnvelope {
  return {
    schemaVersion: DOCK_LAYOUT_SCHEMA_VERSION,
    key: { accountId: "acc", host: "chat", contextId: "s1" },
    grid: root ? { grid: { root, width: 800, height: 600, orientation }, panels: {} } : null,
    instances,
    shell: { ...DEFAULT_DOCK_SHELL_STATE, sizePercent: 42, edge: "left" },
    revision: 3,
    updatedAt: 100,
  }
}

const leaf = (id: string, views: string[], size?: number) => ({
  type: "leaf",
  data: { id, views, activeView: views[0] },
  ...(size !== undefined ? { size } : {}),
})

describe("captureDockPreset", () => {
  it("records panels and grouping but never instance ids or resources", () => {
    const preset = captureDockPreset({
      envelope: envelope(
        [instance("i1", "review"), instance("i2", "preview-panel", "preview")],
        leaf("g1", ["i1", "i2"])
      ),
      name: "My layout",
      id: "preset-1",
      now: 999,
    })
    expect(preset).toEqual({
      id: "preset-1",
      name: "My layout",
      host: "chat",
      schemaVersion: 1,
      root: {
        type: "group",
        panels: [
          { panelId: "review", mode: "pinned" },
          { panelId: "preview-panel", mode: "preview" },
        ],
      },
      shell: { edge: "left", sizePercent: 42 },
      createdAt: 999,
      updatedAt: 999,
    })
    expect(JSON.stringify(preset)).not.toContain("i1")
  })

  it("captures a split with its proportions", () => {
    const preset = captureDockPreset({
      envelope: envelope([instance("i1", "a"), instance("i2", "b")], {
        type: "branch",
        size: 700,
        data: [leaf("g1", ["i1"], 300), leaf("g2", ["i2"], 500)],
      }),
      name: "Split",
      id: "p",
      now: 1,
    })
    expect(preset.root).toEqual({
      type: "split",
      orientation: "horizontal",
      size: 700,
      children: [
        { type: "group", panels: [{ panelId: "a", mode: "pinned" }], size: 300 },
        { type: "group", panels: [{ panelId: "b", mode: "pinned" }], size: 500 },
      ],
    })
  })

  it("alternates orientation with depth, as dockview does", () => {
    const preset = captureDockPreset({
      envelope: envelope(
        [instance("i1", "a"), instance("i2", "b"), instance("i3", "c")],
        {
          type: "branch",
          data: [
            leaf("g1", ["i1"]),
            { type: "branch", data: [leaf("g2", ["i2"]), leaf("g3", ["i3"])] },
          ],
        },
        "VERTICAL"
      ),
      name: "Nested",
      id: "p",
      now: 1,
    })
    expect(preset.root).toMatchObject({ type: "split", orientation: "vertical" })
    const nested = (preset.root as { children: Array<{ orientation?: string }> }).children[1]
    expect(nested).toMatchObject({ type: "split", orientation: "horizontal" })
  })

  it("drops views with no matching instance and collapses what is left", () => {
    const preset = captureDockPreset({
      envelope: envelope([instance("i1", "a")], {
        type: "branch",
        data: [leaf("g1", ["i1"]), leaf("g2", ["ghost"])],
      }),
      name: "Partial",
      id: "p",
      now: 1,
    })
    expect(preset.root).toEqual({ type: "group", panels: [{ panelId: "a", mode: "pinned" }] })
  })

  it("captures an empty layout as a null tree", () => {
    const preset = captureDockPreset({
      envelope: envelope([], null),
      name: "Empty",
      id: "p",
      now: 1,
    })
    expect(preset.root).toBeNull()
  })

  it("survives a malformed grid rather than throwing at the user", () => {
    const broken = envelope([instance("i1", "a")], "not-a-node")
    expect(captureDockPreset({ envelope: broken, name: "x", id: "p", now: 1 }).root).toBeNull()
  })
  it("drops a branch whose children all vanish", () => {
    const preset = captureDockPreset({
      envelope: envelope([], {
        type: "branch",
        data: [leaf("g1", ["gone"]), leaf("g2", ["also"])],
      }),
      name: "x",
      id: "p",
      now: 1,
    })
    expect(preset.root).toBeNull()
  })

  it("ignores views of the wrong type and leaves without a size", () => {
    const preset = captureDockPreset({
      envelope: envelope([instance("i1", "a"), instance("i2", "b")], {
        type: "branch",
        data: [
          { type: "leaf", data: { id: "g1", views: ["i1", 7, null] } },
          { type: "leaf", data: { id: "g2", views: "i2" } },
          { type: "not-a-node" },
          { type: "leaf", data: "nope" },
          { type: "leaf", data: { id: "g3", views: ["i2"] } },
        ],
      }),
      name: "x",
      id: "p",
      now: 1,
    })
    expect(preset.root).toEqual({
      type: "split",
      orientation: "horizontal",
      children: [
        { type: "group", panels: [{ panelId: "a", mode: "pinned" }] },
        { type: "group", panels: [{ panelId: "b", mode: "pinned" }] },
      ],
    })
  })
})

describe("createEmptyDockPreset", () => {
  it("is the rail with nothing docked, and is built in", () => {
    const preset = createEmptyDockPreset({
      id: "builtin-empty",
      name: "Empty",
      host: "chat",
      edge: "right",
      sizePercent: 34,
      now: 5,
    })
    expect(preset).toMatchObject({ root: null, builtin: true, shell: { edge: "right" } })
  })
})

describe("applyDockPreset", () => {
  const preset: DockPreset = {
    id: "p",
    name: "Two up",
    host: "chat",
    schemaVersion: 1,
    root: {
      type: "split",
      orientation: "horizontal",
      children: [
        { type: "group", panels: [{ panelId: "a", mode: "pinned" }], size: 300 },
        {
          type: "group",
          panels: [
            { panelId: "b", mode: "pinned" },
            { panelId: "c", mode: "preview" },
          ],
        },
      ],
    },
    shell: { edge: "right", sizePercent: 40 },
    createdAt: 1,
    updatedAt: 1,
  }

  function apply(available: string[], presetOverride = preset) {
    let n = 0
    return applyDockPreset({
      preset: presetOverride,
      availablePanelIds: new Set(available),
      createInstanceId: () => `new-${++n}`,
      kindOf: (panelId) => (panelId === "browser" ? "native-surface" : "panel"),
    })
  }

  it("mints fresh instances rather than reusing anything from the source", () => {
    const result = apply(["a", "b", "c"])
    expect(result.instances.map((i) => [i.instanceId, i.panelId, i.mode])).toEqual([
      ["new-1", "a", "pinned"],
      ["new-2", "b", "pinned"],
      ["new-3", "c", "preview"],
    ])
    expect(result.instances.every((i) => !i.activated && !i.dirty)).toBe(true)
  })

  it("produces a grid the sanitiser accepts unchanged", () => {
    // The generated grid is never handed straight to dockview — this proves a
    // bug here can produce a wrong layout but never an unsafe one.
    const result = apply(["a", "b", "c"])
    const sanitized = sanitizeDockGrid(
      result.grid,
      result.instances.map((i) => i.instanceId)
    )
    expect(sanitized.droppedPanelIds).toEqual([])
    expect(sanitized.missingInstanceIds).toEqual([])
    expect(sanitized.grid).not.toBeNull()
  })

  it("classifies each new instance by its panel kind", () => {
    const result = apply(["browser"], {
      ...preset,
      root: { type: "group", panels: [{ panelId: "browser", mode: "pinned" }] },
    })
    expect(result.instances[0]?.kind).toBe("native-surface")
  })

  it("skips panels this context cannot offer, and says which", () => {
    // A chat preset applied to a project should give the project's panels, not
    // empty tabs promising ones it does not have.
    const result = apply(["a"])
    expect(result.skippedPanelIds).toEqual(["b", "c"])
    expect(result.instances.map((i) => i.panelId)).toEqual(["a"])
    // The now-single child is hoisted rather than left as a one-child split.
    expect((result.grid?.grid as { root: { type: string } }).root.type).toBe("leaf")
  })

  it("returns an empty layout when nothing in the preset resolves", () => {
    const result = apply([])
    expect(result.instances).toEqual([])
    expect(result.grid).toBeNull()
    expect(result.skippedPanelIds).toEqual(["a", "b", "c"])
  })

  it("applies an empty preset as an empty layout", () => {
    const result = apply(["a"], { ...preset, root: null })
    expect(result.grid).toBeNull()
    expect(result.instances).toEqual([])
  })

  it("carries a vertical root orientation through", () => {
    const result = apply(["a", "b"], {
      ...preset,
      root: {
        type: "split",
        orientation: "vertical",
        children: [
          { type: "group", panels: [{ panelId: "a", mode: "pinned" }] },
          { type: "group", panels: [{ panelId: "b", mode: "pinned" }] },
        ],
      },
    })
    expect((result.grid?.grid as { orientation: string }).orientation).toBe("VERTICAL")
  })

  it("round-trips a captured layout back to the same shape", () => {
    const source = envelope([instance("i1", "a"), instance("i2", "b")], {
      type: "branch",
      data: [leaf("g1", ["i1"], 200), leaf("g2", ["i2"], 400)],
    })
    const captured = captureDockPreset({ envelope: source, name: "rt", id: "p", now: 1 })
    const applied = apply(["a", "b"], captured)
    const recaptured = captureDockPreset({
      envelope: { ...source, grid: applied.grid, instances: applied.instances },
      name: "rt",
      id: "p",
      now: 1,
    })
    expect(recaptured.root).toEqual(captured.root)
  })
  it("carries a split's own size into the grid", () => {
    const result = apply(["a", "b"], {
      ...preset,
      root: {
        type: "split",
        orientation: "horizontal",
        size: 640,
        children: [
          { type: "group", panels: [{ panelId: "a", mode: "pinned" }] },
          { type: "group", panels: [{ panelId: "b", mode: "pinned" }] },
        ],
      },
    })
    expect((result.grid?.grid as { root: { size: number } }).root.size).toBe(640)
  })

  it("keeps a split without an explicit size", () => {
    const result = apply(["a", "b"], {
      ...preset,
      root: {
        type: "split",
        orientation: "horizontal",
        children: [
          { type: "group", panels: [{ panelId: "a", mode: "pinned" }] },
          { type: "group", panels: [{ panelId: "b", mode: "pinned" }] },
        ],
      },
    })
    const root = result.grid?.grid as { root: Record<string, unknown> }
    expect(root.root).not.toHaveProperty("size")
    expect(root.root.type).toBe("branch")
  })
})
