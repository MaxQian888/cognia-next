import { DOCK_PRESET_MAX_NODES, validateDockPreset } from "./validate"
import { DOCK_PRESET_NAME_MAX_LENGTH } from "@/types/dock/preset"

const options = { id: "fresh-id", now: 777 }

function preset(overrides: Record<string, unknown> = {}) {
  return {
    id: "original-id",
    name: "Review layout",
    host: "chat",
    schemaVersion: 1,
    root: { type: "group", panels: [{ panelId: "review", mode: "pinned" }] },
    shell: { edge: "right", sizePercent: 34 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("validateDockPreset", () => {
  it("accepts a well-formed preset and re-mints its id", () => {
    // Importing the same file twice must give two presets, not one silently
    // overwriting the other.
    const result = validateDockPreset(preset(), options)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preset.id).toBe("fresh-id")
    expect(result.preset.createdAt).toBe(777)
    expect(result.preset.root).toEqual({
      type: "group",
      panels: [{ panelId: "review", mode: "pinned" }],
    })
  })

  it("never honours a builtin flag from a file", () => {
    const result = validateDockPreset(preset({ builtin: true }), options)
    expect(result.ok && result.preset.builtin).toBeUndefined()
  })

  it("rejects anything that is not an object", () => {
    for (const raw of [null, undefined, 7, "preset", []]) {
      expect(validateDockPreset(raw, options)).toEqual({ ok: false, rejection: "not-an-object" })
    }
  })

  it("rejects a schema version this build does not speak", () => {
    expect(validateDockPreset(preset({ schemaVersion: 2 }), options)).toEqual({
      ok: false,
      rejection: "schema-version",
    })
    expect(validateDockPreset(preset({ schemaVersion: undefined }), options).ok).toBe(false)
  })

  it("rejects an unknown host", () => {
    expect(validateDockPreset(preset({ host: "terminal" }), options)).toEqual({
      ok: false,
      rejection: "unknown-host",
    })
    expect(validateDockPreset(preset({ host: 7 }), options).ok).toBe(false)
  })

  it("rejects an empty or oversized name and trims what it keeps", () => {
    expect(validateDockPreset(preset({ name: "   " }), options)).toEqual({
      ok: false,
      rejection: "invalid-name",
    })
    expect(validateDockPreset(preset({ name: 7 }), options).ok).toBe(false)
    expect(
      validateDockPreset(preset({ name: "x".repeat(DOCK_PRESET_NAME_MAX_LENGTH + 1) }), options).ok
    ).toBe(false)

    const trimmed = validateDockPreset(preset({ name: "  Spaced  " }), options)
    expect(trimmed.ok && trimmed.preset.name).toBe("Spaced")
  })

  it("rejects a malformed shell", () => {
    for (const shell of [
      undefined,
      "right",
      { edge: "diagonal", sizePercent: 30 },
      { edge: "right" },
      { edge: "right", sizePercent: 0 },
      { edge: "right", sizePercent: Number.NaN },
    ]) {
      expect(validateDockPreset(preset({ shell }), options)).toEqual({
        ok: false,
        rejection: "invalid-shell",
      })
    }
  })

  it("accepts a null root as the empty preset", () => {
    const result = validateDockPreset(preset({ root: null }), options)
    expect(result.ok && result.preset.root).toBeNull()
    expect(validateDockPreset(preset({ root: undefined }), options).ok).toBe(true)
  })

  it("rejects a malformed tree in every shape", () => {
    const bad = [
      7,
      { type: "leaf" },
      { type: "group", panels: [] },
      { type: "group", panels: "review" },
      { type: "group", panels: [{ panelId: "", mode: "pinned" }] },
      { type: "group", panels: [{ panelId: "a", mode: "sideways" }] },
      { type: "group", panels: [7] },
      { type: "split", orientation: "diagonal", children: [] },
      { type: "split", orientation: "horizontal", children: [] },
      { type: "split", orientation: "horizontal" },
    ]
    for (const root of bad) {
      expect(validateDockPreset(preset({ root }), options)).toMatchObject({
        ok: false,
        rejection: "invalid-tree",
      })
    }
  })

  it("keeps a valid split with its sizes and drops implausible ones", () => {
    const result = validateDockPreset(
      preset({
        root: {
          type: "split",
          orientation: "vertical",
          size: 400,
          children: [
            { type: "group", panels: [{ panelId: "a", mode: "pinned" }], size: 100 },
            { type: "group", panels: [{ panelId: "b", mode: "pinned" }], size: -5 },
          ],
        },
      }),
      options
    )
    expect(result.ok && result.preset.root).toEqual({
      type: "split",
      orientation: "vertical",
      size: 400,
      children: [
        { type: "group", panels: [{ panelId: "a", mode: "pinned" }], size: 100 },
        { type: "group", panels: [{ panelId: "b", mode: "pinned" }] },
      ],
    })
  })

  it("collapses a split down to its single valid child", () => {
    const result = validateDockPreset(
      preset({
        root: {
          type: "split",
          orientation: "horizontal",
          children: [{ type: "group", panels: [{ panelId: "a", mode: "pinned" }] }],
        },
      }),
      options
    )
    expect(result.ok && result.preset.root).toMatchObject({ type: "group" })
  })

  it("rejects a panel the build does not know when a catalogue is supplied", () => {
    const result = validateDockPreset(preset(), {
      ...options,
      allowedPanelIds: new Set(["something-else"]),
    })
    expect(result).toEqual({ ok: false, rejection: "unknown-panel", panelId: "review" })
  })

  it("checks the tree even without a catalogue", () => {
    expect(validateDockPreset(preset(), options).ok).toBe(true)
    expect(validateDockPreset(preset({ root: { type: "group", panels: [] } }), options).ok).toBe(
      false
    )
  })

  it("refuses a tree deep enough to be a denial of service", () => {
    let root: unknown = { type: "group", panels: [{ panelId: "a", mode: "pinned" }] }
    for (let i = 0; i < DOCK_PRESET_MAX_NODES + 5; i += 1) {
      root = { type: "split", orientation: "horizontal", children: [root] }
    }
    expect(validateDockPreset(preset({ root }), options)).toEqual({
      ok: false,
      rejection: "too-large",
    })
  })
  it("keeps a split whose size is absent", () => {
    const result = validateDockPreset(
      preset({
        root: {
          type: "split",
          orientation: "horizontal",
          children: [
            { type: "group", panels: [{ panelId: "a", mode: "pinned" }] },
            { type: "group", panels: [{ panelId: "b", mode: "pinned" }] },
          ],
        },
      }),
      options
    )
    expect(result.ok && result.preset.root).not.toHaveProperty("size")
  })
})
