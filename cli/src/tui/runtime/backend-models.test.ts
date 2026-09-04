/**
 * @jest-environment node
 */
const getCodexAppServerAdapter = jest.fn()
const fetchAgentModelCatalog = jest.fn()

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ getCodexAppServerAdapter, fetchAgentModelCatalog }),
}))

/** What `fetchAgentModelCatalog` answers for an agent with no such catalog. */
const UNSUPPORTED = { status: "unsupported" as const }

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
  beforeEach(() => {
    getCodexAppServerAdapter.mockReset()
    fetchAgentModelCatalog.mockReset()
    fetchAgentModelCatalog.mockResolvedValue(UNSUPPORTED)
  })

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
    // An agent with neither a sessionless catalog nor `model/list` lands here:
    // the picker reports "no models offered" rather than falling back to the
    // built-in catalog, which that agent cannot run.
    getCodexAppServerAdapter.mockReturnValue(null)
    await expect(defaultBackendModelHost().listExternalModels("a1")).resolves.toEqual([])
  })

  it("reads a pull-based agent's sessionless catalog (Pi)", async () => {
    // The regression: Pi answers `get_available_models` through the manager's
    // catalog, not through the Codex adapter, so asking only the Codex adapter
    // reported "did not report any models" for an agent that has dozens.
    getCodexAppServerAdapter.mockReturnValue(null)
    fetchAgentModelCatalog.mockResolvedValue({
      status: "ok",
      data: {
        models: {
          choices: [
            { modelId: "claude-opus-5", name: "Claude Opus 5" },
            { modelId: "gpt-5.3-codex", name: "gpt-5.3-codex" },
          ],
          currentModelId: "claude-opus-5",
          write: { kind: "session-seed" },
        },
        thinking: { levels: [], currentLevel: null, write: { kind: "none" } },
      },
    })
    await expect(defaultBackendModelHost().listExternalModels("a1")).resolves.toEqual([
      { id: "claude-opus-5", name: "Claude Opus 5" },
      // The agent named it after its own id, so the label carries no duplicate.
      { id: "gpt-5.3-codex" },
    ])
    expect(getCodexAppServerAdapter).not.toHaveBeenCalled()
  })

  it("still asks Codex when the catalog answers with an empty list", async () => {
    // `ok` with no choices is not an answer, it is an agent that knows nothing
    // yet. Treating it as one would hide the route that does have models.
    fetchAgentModelCatalog.mockResolvedValue({
      status: "ok",
      data: {
        models: { choices: [], currentModelId: null, write: { kind: "none" } },
        thinking: { levels: [], currentLevel: null, write: { kind: "none" } },
      },
    })
    getCodexAppServerAdapter.mockReturnValue({
      listModels: async () => [{ id: "gpt-5.2-codex" }],
    })
    await expect(defaultBackendModelHost().listExternalModels("a1")).resolves.toEqual([
      { id: "gpt-5.2-codex" },
    ])
  })

  it("falls through to Codex when the catalog itself throws", async () => {
    fetchAgentModelCatalog.mockRejectedValue(new Error("pi is wedged"))
    getCodexAppServerAdapter.mockReturnValue({
      listModels: async () => [{ id: "gpt-5.2-codex" }],
    })
    await expect(defaultBackendModelHost().listExternalModels("a1")).resolves.toEqual([
      { id: "gpt-5.2-codex" },
    ])
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
