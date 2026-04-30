/**
 * @jest-environment jsdom
 */
import {
  selectCustomModes,
  selectCustomModeById,
  selectActiveCustomMode,
  selectIsGenerating,
  selectGenerationError,
  selectCustomModeCount,
} from "./selectors"
import type { CustomModeState } from "./types"
import type { CustomModeConfig } from "./definitions"

const baseState = (overrides: Partial<CustomModeState> = {}): CustomModeState =>
  ({
    customModes: {},
    activeModeId: null,
    isGenerating: false,
    generationError: null,
    ...overrides,
  }) as unknown as CustomModeState

const buildMode = (id: string, name: string): CustomModeConfig =>
  ({
    id,
    type: "custom",
    isBuiltIn: false,
    name,
    description: "",
    icon: "Bot",
    systemPrompt: "",
    tools: [],
    outputFormat: "text",
    customConfig: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as CustomModeConfig

describe("custom-mode-store selectors against empty state", () => {
  const state = baseState()

  it("returns empty / default values", () => {
    expect(selectCustomModes(state)).toEqual([])
    expect(selectCustomModeById("any")(state)).toBeUndefined()
    expect(selectActiveCustomMode(state)).toBeUndefined()
    expect(selectIsGenerating(state)).toBe(false)
    expect(selectGenerationError(state)).toBeNull()
    expect(selectCustomModeCount(state)).toBe(0)
  })
})

describe("custom-mode-store selectors against populated state", () => {
  const a = buildMode("a", "Alpha")
  const b = buildMode("b", "Beta")
  const state = baseState({
    customModes: { a, b },
    activeModeId: "a",
    isGenerating: true,
    generationError: "boom",
  })

  it("returns full lists, finds active mode, surfaces flags", () => {
    expect(
      selectCustomModes(state)
        .map((m) => m.id)
        .sort()
    ).toEqual(["a", "b"])
    expect(selectCustomModeById("a")(state)?.id).toBe("a")
    expect(selectCustomModeById("missing")(state)).toBeUndefined()
    expect(selectActiveCustomMode(state)?.id).toBe("a")
    expect(selectIsGenerating(state)).toBe(true)
    expect(selectGenerationError(state)).toBe("boom")
    expect(selectCustomModeCount(state)).toBe(2)
  })

  it("returns undefined for a stale activeModeId", () => {
    const stale = baseState({ customModes: { a }, activeModeId: "ghost" })
    expect(selectActiveCustomMode(stale)).toBeUndefined()
  })
})
