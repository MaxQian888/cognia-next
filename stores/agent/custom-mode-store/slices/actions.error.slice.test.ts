/**
 * @jest-environment jsdom
 *
 * The `generateModeFromDescription` happy-path is covered in actions.slice.test.ts.
 * This file isolates the catch branch by mocking the helpers module so the
 * action throws without depending on real heuristic input.
 */
jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return { loggers: { agent: { ...child, child: () => child } } }
})

jest.mock("../helpers", () => ({
  __esModule: true,
  analyzeModeDescription: jest.fn(),
  PROMPT_TEMPLATE_VARIABLES: {},
  processPromptTemplateVariables: jest.fn((p: string) => p),
  getTemplateVariablePreview: jest.fn(() => ({})),
  getRecommendedMcpToolsForMode: jest.fn(() => []),
  autoSelectMcpToolsForMode: jest.fn(() => []),
}))

import { analyzeModeDescription } from "../helpers"
import { useCustomModeStore } from "../store"

describe("useCustomModeStore generateModeFromDescription error paths", () => {
  beforeEach(() => {
    useCustomModeStore.getState().reset()
    ;(analyzeModeDescription as jest.Mock).mockReset()
  })

  it("captures Error.message in generationError and clears isGenerating", async () => {
    ;(analyzeModeDescription as jest.Mock).mockImplementation(() => {
      throw new Error("forced")
    })
    await expect(
      useCustomModeStore.getState().generateModeFromDescription({ description: "x" })
    ).rejects.toThrow(/forced/)
    expect(useCustomModeStore.getState().isGenerating).toBe(false)
    expect(useCustomModeStore.getState().generationError).toBe("forced")
  })

  it("treats non-Error throws as 'Generation failed'", async () => {
    ;(analyzeModeDescription as jest.Mock).mockImplementation(() => {
      throw "boom"
    })
    await expect(
      useCustomModeStore.getState().generateModeFromDescription({ description: "x" })
    ).rejects.toBe("boom")
    expect(useCustomModeStore.getState().generationError).toBe("Generation failed")
  })
})
