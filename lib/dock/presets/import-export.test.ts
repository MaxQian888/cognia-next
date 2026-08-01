import {
  DOCK_PRESET_MAX_FILE_BYTES,
  dockPresetFileName,
  parseDockPresetFile,
  serializeDockPreset,
} from "./import-export"
import type { DockPreset } from "@/types/dock/preset"

const options = { id: "fresh-id", now: 555 }

const preset: DockPreset = {
  id: "local-id",
  name: "Review layout",
  host: "chat",
  schemaVersion: 1,
  root: { type: "group", panels: [{ panelId: "review", mode: "pinned" }] },
  shell: { edge: "right", sizePercent: 34 },
  createdAt: 1,
  updatedAt: 2,
}

describe("serializeDockPreset", () => {
  it("writes a kind-marked file that round-trips", () => {
    const parsed = parseDockPresetFile(serializeDockPreset(preset), options)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.preset.name).toBe("Review layout")
    expect(parsed.preset.root).toEqual(preset.root)
    expect(parsed.preset.id).toBe("fresh-id")
  })

  it("never exports the builtin flag", () => {
    // A preset shipped with one build is not shipped with the machine
    // importing it.
    const text = serializeDockPreset({ ...preset, builtin: true })
    expect(JSON.parse(text).preset.builtin).toBeUndefined()
    const parsed = parseDockPresetFile(text, options)
    expect(parsed.ok && parsed.preset.builtin).toBeUndefined()
  })
})

describe("dockPresetFileName", () => {
  it("slugs the name into something safe on every platform", () => {
    expect(dockPresetFileName(preset)).toBe("cognia-dock-chat-review-layout.json")
    expect(dockPresetFileName({ ...preset, name: "  ../../etc/passwd  " })).toBe(
      "cognia-dock-chat-etc-passwd.json"
    )
  })

  it("falls back when the name has nothing sluggable in it", () => {
    expect(dockPresetFileName({ ...preset, name: "布局" })).toBe("cognia-dock-chat-preset.json")
  })

  it("clamps a very long name", () => {
    const name = dockPresetFileName({ ...preset, name: "a".repeat(200) })
    expect(name.length).toBeLessThan(80)
  })
})

describe("parseDockPresetFile", () => {
  it("rejects text that is not JSON", () => {
    expect(parseDockPresetFile("{not json", options)).toEqual({ ok: false, rejection: "not-json" })
  })

  it("rejects a file that is not a dock preset", () => {
    for (const text of ['{"kind":"something-else"}', "null", "[]", '"a string"', "7"]) {
      expect(parseDockPresetFile(text, options)).toEqual({ ok: false, rejection: "wrong-kind" })
    }
  })

  it("refuses to read a file too large to be a preset", () => {
    const huge = `{"kind":"cognia.dock.preset","x":"${"a".repeat(DOCK_PRESET_MAX_FILE_BYTES)}"}`
    expect(parseDockPresetFile(huge, options)).toEqual({ ok: false, rejection: "too-large" })
  })

  it("forwards the validator's rejection rather than repairing the file", () => {
    const text = JSON.stringify({
      kind: "cognia.dock.preset",
      schemaVersion: 1,
      preset: { ...preset, host: "nowhere" },
    })
    expect(parseDockPresetFile(text, options)).toEqual({ ok: false, rejection: "unknown-host" })
  })

  it("reports which panel an import could not satisfy", () => {
    const result = parseDockPresetFile(serializeDockPreset(preset), {
      ...options,
      allowedPanelIds: new Set(["other"]),
    })
    expect(result).toEqual({ ok: false, rejection: "unknown-panel", panelId: "review" })
  })

  it("rejects a file whose preset payload is missing", () => {
    const text = JSON.stringify({ kind: "cognia.dock.preset", schemaVersion: 1 })
    expect(parseDockPresetFile(text, options)).toEqual({ ok: false, rejection: "not-an-object" })
  })
})
