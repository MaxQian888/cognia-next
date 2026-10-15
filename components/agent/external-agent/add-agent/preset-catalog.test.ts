import {
  getAvailablePresets,
  getPresetConfig,
  getRunnablePresets,
} from "@/lib/ai/agent/external/config/presets"
import type { InstalledRuntime } from "@/lib/ai/agent/external/config/installed-runtimes"

import {
  availablePresetEntries,
  groupPresetEntries,
  runnablePresetEntries,
  type PresetEntry,
} from "./preset-catalog"

function runtime(resolution: InstalledRuntime["resolution"]): InstalledRuntime {
  return {
    runtimeId: "r",
    command: "x",
    resolution,
    executablePath: null,
    version: null,
    detail: null,
  }
}

const entries = runnablePresetEntries((id, preset) => ({
  name: `${preset.name} (${id})`,
  description: preset.description ?? "",
}))

describe("runnablePresetEntries", () => {
  it("lists every runnable preset, in catalogue order, with the copy it was given", () => {
    expect(entries.map((entry) => entry.id)).toEqual(
      getRunnablePresets().filter((id) => getPresetConfig(id))
    )
    const first = entries[0]
    expect(first.preset).toBe(getPresetConfig(first.id))
    expect(first.name).toBe(`${first.preset.name} (${first.id})`)
  })
})

describe("groupPresetEntries", () => {
  const [a, b, c] = entries
  const sample: PresetEntry[] = [a, b, c]

  it("puts what the Host has installed first and keeps catalogue order inside each group", () => {
    const resolutions: Record<string, InstalledRuntime> = {
      [c.id]: runtime("installed"),
      [a.id]: runtime("package-runner"),
    }
    const grouped = groupPresetEntries(sample, (id) => resolutions[id], "")
    expect(grouped.installed.map((entry) => entry.id)).toEqual([c.id])
    // Runnable through a package runner is not installed; neither is unknown.
    expect(grouped.others.map((entry) => entry.id)).toEqual([a.id, b.id])
  })

  it("narrows both groups by every search term, case-insensitively, keeping the split", () => {
    const named: PresetEntry[] = [
      { ...a, name: "Claude Code", description: "Anthropic coding agent" },
      { ...b, name: "Codex", description: "OpenAI coding agent" },
    ]
    const installedB = (id: string) => (id === b.id ? runtime("installed") : undefined)

    expect(groupPresetEntries(named, installedB, "  CODING   agent ")).toEqual({
      installed: [named[1]],
      others: [named[0]],
      experimental: [],
    })
    expect(groupPresetEntries(named, installedB, "anthropic")).toEqual({
      installed: [],
      others: [named[0]],
      experimental: [],
    })
    expect(groupPresetEntries(named, installedB, "nothing-matches")).toEqual({
      installed: [],
      others: [],
      experimental: [],
    })
  })

  it("matches on the preset id and its tags too", () => {
    const tagged: PresetEntry = {
      ...a,
      id: "zz-agent",
      name: "Display",
      description: "",
      preset: { ...a.preset, tags: ["terminal"] },
    }
    expect(groupPresetEntries([tagged], () => undefined, "zz-agent").others).toEqual([tagged])
    expect(groupPresetEntries([tagged], () => undefined, "terminal").others).toEqual([tagged])
  })
})

describe("availablePresetEntries", () => {
  it("includes the experimental desktop presets without offering them on the phone", () => {
    const available = availablePresetEntries((id, preset) => ({
      name: id,
      description: preset.description,
    }))
    expect(available.map((entry) => entry.id)).toEqual(
      getAvailablePresets().filter((id) => getPresetConfig(id))
    )
    const experimental = available.filter((entry) => entry.preset.supportTier === "documented-only")
    expect(experimental.length).toBeGreaterThan(0)
    expect(entries.every((entry) => entry.preset.supportTier !== "documented-only")).toBe(true)
    const grouped = groupPresetEntries(available, () => runtime("installed"), "")
    expect(grouped.experimental).toEqual(experimental)
    expect(grouped.installed.every((entry) => entry.preset.supportTier !== "documented-only")).toBe(
      true
    )
  })

  it("searches entries with absent plugin tags safely", () => {
    const entry = {
      ...entries[0],
      preset: { ...entries[0].preset, tags: undefined },
    } as unknown as PresetEntry
    expect(groupPresetEntries([entry], () => undefined, entry.name).others).toEqual([entry])
  })
})
