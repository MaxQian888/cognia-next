/**
 * @jest-environment jsdom
 */
import { useCustomModeStore } from "../index"
import type { CustomModeConfig } from "../definitions"

jest.mock("@/lib/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    loggers: {
      agent: { ...child, child: () => child },
    },
  }
})

const reset = () => {
  useCustomModeStore.getState().reset()
}

describe("useCustomModeStore actions", () => {
  beforeEach(() => {
    reset()
  })

  it("createMode persists a mode and returns it", () => {
    const created = useCustomModeStore.getState().createMode({
      name: "Coder",
      description: "writes code",
    })
    expect(created.id).toMatch(/^custom-/)
    expect(created.type).toBe("custom")
    expect(created.isBuiltIn).toBe(false)
    const stored = useCustomModeStore.getState().customModes[created.id]
    expect(stored).toBeDefined()
    expect(stored.name).toBe("Coder")
  })

  it("createMode falls back to a default name when omitted", () => {
    const created = useCustomModeStore.getState().createMode({})
    expect(created.name).toBe("New Custom Mode")
  })

  // §A-2 plugin extension: a mode contributed by a plugin carries through
  // the `source` and `pluginId` fields so the plugin manager can later
  // bulk-remove this mode by filtering on `pluginId`. User-created modes
  // omit both fields so the serialized shape is unchanged.
  it("createMode preserves plugin origin when source/pluginId are passed", () => {
    const created = useCustomModeStore.getState().createMode({
      name: "Claude Code mode",
      source: "plugin",
      pluginId: "cognia-next-claude-code-agent",
    })
    expect(created.source).toBe("plugin")
    expect(created.pluginId).toBe("cognia-next-claude-code-agent")
    const stored = useCustomModeStore.getState().customModes[created.id]
    expect(stored.source).toBe("plugin")
    expect(stored.pluginId).toBe("cognia-next-claude-code-agent")
  })

  it("createMode omits source/pluginId for user-created modes (backwards-compat)", () => {
    const created = useCustomModeStore.getState().createMode({ name: "Hand-rolled" })
    // Use Object.prototype.hasOwnProperty so the assertion is precise: the
    // fields must not be persisted at all, not merely set to `undefined`.
    expect(Object.prototype.hasOwnProperty.call(created, "source")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(created, "pluginId")).toBe(false)
  })

  it("updateMode merges patches and bumps updatedAt", async () => {
    const created = useCustomModeStore.getState().createMode({ name: "Original" })
    const before = useCustomModeStore.getState().customModes[created.id].updatedAt
    await new Promise((r) => setTimeout(r, 5))
    useCustomModeStore.getState().updateMode(created.id, { name: "Renamed" })
    const after = useCustomModeStore.getState().customModes[created.id]
    expect(after.name).toBe("Renamed")
    expect(after.updatedAt.getTime()).toBeGreaterThan((before as Date).getTime())
  })

  it("updateMode is a no-op when the id is unknown", () => {
    const before = useCustomModeStore.getState().customModes
    useCustomModeStore.getState().updateMode("nonexistent", { name: "Nope" })
    expect(useCustomModeStore.getState().customModes).toBe(before)
  })

  it("deleteMode removes the mode and clears it from activeModeId if active", () => {
    const created = useCustomModeStore.getState().createMode({ name: "Doomed" })
    useCustomModeStore.setState({ activeModeId: created.id })
    useCustomModeStore.getState().deleteMode(created.id)
    expect(useCustomModeStore.getState().customModes[created.id]).toBeUndefined()
    expect(useCustomModeStore.getState().activeModeId).toBeNull()
  })

  it("exportMode/importMode roundtrips a custom mode", () => {
    const created = useCustomModeStore.getState().createMode({ name: "Export Me" })
    const json = useCustomModeStore.getState().exportMode(created.id)
    expect(json).not.toBeNull()
    const imported = useCustomModeStore.getState().importMode(json!)
    expect(imported).not.toBeNull()
    expect(imported!.name).toBe("Export Me")
    expect(imported!.id).not.toBe(created.id) // generated fresh
  })

  it("exportMode returns null for an unknown id", () => {
    expect(useCustomModeStore.getState().exportMode("missing")).toBeNull()
  })

  it("importMode returns null on malformed payload", () => {
    expect(useCustomModeStore.getState().importMode("{not json")).toBeNull()
    expect(useCustomModeStore.getState().importMode(JSON.stringify({ type: "wrong" }))).toBeNull()
  })

  it("exportAllModes / importModes roundtrips multiple modes", () => {
    useCustomModeStore.getState().createMode({ name: "A" })
    useCustomModeStore.getState().createMode({ name: "B" })
    const json = useCustomModeStore.getState().exportAllModes()
    reset()
    const count = useCustomModeStore.getState().importModes(json)
    expect(count).toBe(2)
    expect(
      Object.values(useCustomModeStore.getState().customModes)
        .map((m) => m.name)
        .sort()
    ).toEqual(["A", "B"])
  })

  it("importModes returns 0 on bad input", () => {
    expect(useCustomModeStore.getState().importModes("{")).toBe(0)
    expect(useCustomModeStore.getState().importModes(JSON.stringify({ modes: [] }))).toBe(0)
  })

  it("generateModeFromDescription resolves with a result and clears isGenerating", async () => {
    const result = await useCustomModeStore.getState().generateModeFromDescription({
      description: "research assistant for academic papers",
      includeA2UI: false,
    })
    expect(result.suggestedTools.length).toBeGreaterThan(0)
    expect(useCustomModeStore.getState().isGenerating).toBe(false)
    expect(useCustomModeStore.getState().generationError).toBeNull()
  })

  it("setGenerationError surfaces the message in state", () => {
    useCustomModeStore.getState().setGenerationError("boom")
    expect(useCustomModeStore.getState().generationError).toBe("boom")
  })

  it("setActiveMode swaps the active id and accepts null", () => {
    const a = useCustomModeStore.getState().createMode({ name: "A" })
    useCustomModeStore.getState().setActiveMode(a.id)
    expect(useCustomModeStore.getState().activeModeId).toBe(a.id)
    useCustomModeStore.getState().setActiveMode(null)
    expect(useCustomModeStore.getState().activeModeId).toBeNull()
  })

  it("deleteMode preserves activeModeId when deleting a different mode", () => {
    const a = useCustomModeStore.getState().createMode({ name: "A" })
    const b = useCustomModeStore.getState().createMode({ name: "B" })
    useCustomModeStore.setState({ activeModeId: a.id })
    useCustomModeStore.getState().deleteMode(b.id)
    expect(useCustomModeStore.getState().activeModeId).toBe(a.id)
  })

  it("getMode resolves an id (or undefined for missing)", () => {
    const a = useCustomModeStore.getState().createMode({ name: "A" })
    expect(useCustomModeStore.getState().getMode(a.id)?.id).toBe(a.id)
    expect(useCustomModeStore.getState().getMode("ghost")).toBeUndefined()
  })

  it("duplicateMode clones with a new id and resets usage counters", () => {
    const a = useCustomModeStore.getState().createMode({ name: "A" })
    useCustomModeStore.getState().recordModeUsage(a.id)
    const clone = useCustomModeStore.getState().duplicateMode(a.id)
    expect(clone).not.toBeNull()
    expect(clone!.id).not.toBe(a.id)
    expect(clone!.name).toBe("A (Copy)")
    expect(clone!.usageCount).toBe(0)
    expect(clone!.lastUsedAt).toBeUndefined()
  })

  it("duplicateMode returns null for unknown id", () => {
    expect(useCustomModeStore.getState().duplicateMode("missing")).toBeNull()
  })

  it("getModesByCategory filters by category", () => {
    useCustomModeStore.getState().createMode({ name: "A", category: "creative" })
    useCustomModeStore.getState().createMode({ name: "B", category: "technical" })
    expect(
      useCustomModeStore
        .getState()
        .getModesByCategory("creative")
        .map((m) => m.name)
    ).toEqual(["A"])
  })

  it("getModesByTags returns modes that have any matching tag", () => {
    useCustomModeStore.getState().createMode({ name: "A", tags: ["x", "y"] })
    useCustomModeStore.getState().createMode({ name: "B", tags: ["y", "z"] })
    useCustomModeStore.getState().createMode({ name: "C", tags: [] })
    const matched = useCustomModeStore
      .getState()
      .getModesByTags(["y"])
      .map((m) => m.name)
      .sort()
    expect(matched).toEqual(["A", "B"])
  })

  it("searchModes matches name, description, and tags", () => {
    useCustomModeStore.getState().createMode({ name: "Alpha", description: "" })
    useCustomModeStore.getState().createMode({
      name: "Beta",
      description: "research helper",
    })
    useCustomModeStore.getState().createMode({ name: "Gamma", tags: ["coding"] })
    expect(
      useCustomModeStore
        .getState()
        .searchModes("alpha")
        .map((m) => m.name)
    ).toEqual(["Alpha"])
    expect(
      useCustomModeStore
        .getState()
        .searchModes("research")
        .map((m) => m.name)
    ).toEqual(["Beta"])
    expect(
      useCustomModeStore
        .getState()
        .searchModes("coding")
        .map((m) => m.name)
    ).toEqual(["Gamma"])
  })

  it("getRecentModes orders by lastUsedAt and respects the limit", async () => {
    const a = useCustomModeStore.getState().createMode({ name: "A" })
    const b = useCustomModeStore.getState().createMode({ name: "B" })
    useCustomModeStore.getState().recordModeUsage(a.id)
    await new Promise((r) => setTimeout(r, 5))
    useCustomModeStore.getState().recordModeUsage(b.id)
    const recent = useCustomModeStore.getState().getRecentModes(2)
    expect(recent.map((m) => m.id)).toEqual([b.id, a.id])
    // Filter out unused modes
    useCustomModeStore.getState().createMode({ name: "C" }) // not used
    const recent2 = useCustomModeStore.getState().getRecentModes()
    expect(recent2.map((m) => m.id)).toEqual([b.id, a.id])
  })

  it("getMostUsedModes orders by usageCount and respects the limit", () => {
    const a = useCustomModeStore.getState().createMode({ name: "A" })
    const b = useCustomModeStore.getState().createMode({ name: "B" })
    useCustomModeStore.getState().recordModeUsage(b.id)
    useCustomModeStore.getState().recordModeUsage(b.id)
    useCustomModeStore.getState().recordModeUsage(a.id)
    const ranked = useCustomModeStore.getState().getMostUsedModes(2)
    expect(ranked.map((m) => m.id)).toEqual([b.id, a.id])
  })

  it("recordModeUsage is a no-op for unknown id", () => {
    const before = useCustomModeStore.getState().customModes
    useCustomModeStore.getState().recordModeUsage("missing")
    expect(useCustomModeStore.getState().customModes).toBe(before)
  })

  it("setModeA2UITemplate sets and clears the template", () => {
    const a = useCustomModeStore.getState().createMode({ name: "A" })
    useCustomModeStore.getState().setModeA2UITemplate(a.id, {
      id: "tpl",
      name: "T",
      components: [],
      dataModel: {},
    })
    expect(useCustomModeStore.getState().customModes[a.id].a2uiTemplate?.id).toBe("tpl")
    expect(useCustomModeStore.getState().customModes[a.id].a2uiEnabled).toBe(true)
    useCustomModeStore.getState().setModeA2UITemplate(a.id, undefined)
    expect(useCustomModeStore.getState().customModes[a.id].a2uiTemplate).toBeUndefined()
    expect(useCustomModeStore.getState().customModes[a.id].a2uiEnabled).toBe(false)
    // unknown id no-op
    useCustomModeStore.getState().setModeA2UITemplate("missing", undefined)
  })

  it("createMode preserves an explicit id when provided", () => {
    const created = useCustomModeStore.getState().createMode({ id: "fixed-id", name: "Pinned" })
    expect(created.id).toBe("fixed-id")
    expect(useCustomModeStore.getState().customModes["fixed-id"]).toBeDefined()
  })
})

describe("usage tracking", () => {
  beforeEach(() => {
    reset()
  })

  it("recordModeUsage increments the count for an existing mode", () => {
    const created = useCustomModeStore.getState().createMode({ name: "Used" })
    const before = (useCustomModeStore.getState().customModes[created.id] as CustomModeConfig)
      .usageCount
    useCustomModeStore.getState().recordModeUsage(created.id)
    const after = useCustomModeStore.getState().customModes[created.id] as CustomModeConfig
    expect(after.usageCount).toBe((before ?? 0) + 1)
  })
})
