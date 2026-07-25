/**
 * @jest-environment node
 */
const getCodexAppServerAdapter = jest.fn()

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ getCodexAppServerAdapter }),
}))

import { defaultBackendModelHost, formatExternalModelLabel } from "./backend-models"

describe("formatExternalModelLabel", () => {
  it("shows the display name alongside the id that is actually sent", () => {
    expect(formatExternalModelLabel({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" })).toBe(
      "GPT-5.6 Sol (gpt-5.6-sol)"
    )
  })

  it("does not repeat the id when the agent's name IS the id", () => {
    expect(formatExternalModelLabel({ id: "gpt-5.6-sol", name: "gpt-5.6-sol" })).toBe("gpt-5.6-sol")
  })

  it("falls back to the bare id when the agent supplies no name", () => {
    expect(formatExternalModelLabel({ id: "gpt-5.2-codex" })).toBe("gpt-5.2-codex")
  })
})

describe("defaultBackendModelHost", () => {
  beforeEach(() => getCodexAppServerAdapter.mockReset())

  it("returns the models the connected agent reports for itself", async () => {
    getCodexAppServerAdapter.mockReturnValue({
      listModels: async () => [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }, { id: "gpt-5.2-codex" }],
    })
    await expect(defaultBackendModelHost().listExternalModels("a1")).resolves.toEqual([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-5.2-codex" },
    ])
  })

  it("returns nothing when the agent has no model-list method", async () => {
    // Every non-Codex agent lands here: the picker reports "no models offered"
    // rather than falling back to the built-in catalog, which that agent
    // cannot run.
    getCodexAppServerAdapter.mockReturnValue(null)
    await expect(defaultBackendModelHost().listExternalModels("a1")).resolves.toEqual([])
  })

  it("survives a wedged agent instead of taking the picker down", async () => {
    getCodexAppServerAdapter.mockReturnValue({
      listModels: async () => {
        throw new Error("Request timeout: model/list")
      },
    })
    await expect(defaultBackendModelHost().listExternalModels("a1")).resolves.toEqual([])
  })
})
