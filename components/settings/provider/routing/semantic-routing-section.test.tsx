/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async () => undefined)
let settingsState: Record<string, unknown> = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ settings: settingsState, save: saveMock }),
}))

import { SemanticRoutingSection } from "./semantic-routing-section"
import { DifficultyRoutingSection } from "./difficulty-routing-section"

beforeEach(() => {
  saveMock.mockClear()
  settingsState = {}
})

describe("SemanticRoutingSection", () => {
  it("renders defaults and toggles enabled via save patch", () => {
    render(<SemanticRoutingSection />)
    const toggle = screen.getByRole("switch")
    expect(toggle).toHaveAttribute("aria-checked", "false")
    fireEvent.click(toggle)
    expect(saveMock).toHaveBeenCalledWith({
      semanticToolRouting: expect.objectContaining({ enabled: true, topK: 12 }),
    })
  })

  it("persists numeric knobs and pinned tools", () => {
    settingsState = {
      semanticToolRouting: {
        enabled: true,
        activationToolCount: 24,
        topK: 12,
        threshold: 0.35,
        pinnedTools: [],
      },
    }
    render(<SemanticRoutingSection />)
    fireEvent.change(screen.getByLabelText("topK"), { target: { value: "5" } })
    expect(saveMock).toHaveBeenCalledWith({
      semanticToolRouting: expect.objectContaining({ topK: 5 }),
    })
    fireEvent.change(screen.getByLabelText("pinnedTools"), {
      target: { value: "alpha, beta , ,gamma" },
    })
    expect(saveMock).toHaveBeenCalledWith({
      semanticToolRouting: expect.objectContaining({ pinnedTools: ["alpha", "beta", "gamma"] }),
    })
    // Out-of-range threshold is ignored.
    fireEvent.change(screen.getByLabelText("threshold"), { target: { value: "7" } })
    expect(saveMock).not.toHaveBeenCalledWith({
      semanticToolRouting: expect.objectContaining({ threshold: 7 }),
    })
  })
})

describe("DifficultyRoutingSection", () => {
  it("toggles enabled and persists the model pair", () => {
    settingsState = { difficultyRouting: { enabled: true, threshold: 0.5 } }
    render(<DifficultyRoutingSection />)
    fireEvent.change(
      screen.getByLabelText("providerId", { selector: "#difficulty-weak-provider" }),
      {
        target: { value: "openai" },
      }
    )
    expect(saveMock).toHaveBeenCalledWith({
      difficultyRouting: expect.objectContaining({
        weakModel: { providerId: "openai", modelId: "" },
      }),
    })
    fireEvent.change(screen.getByLabelText("modelId", { selector: "#difficulty-strong-model" }), {
      target: { value: "claude-opus" },
    })
    expect(saveMock).toHaveBeenCalledWith({
      difficultyRouting: expect.objectContaining({
        strongModel: { providerId: "", modelId: "claude-opus" },
      }),
    })
  })

  it("clearing both halves of a pair stores undefined", () => {
    settingsState = {
      difficultyRouting: {
        enabled: true,
        threshold: 0.5,
        weakModel: { providerId: "openai", modelId: "" },
      },
    }
    render(<DifficultyRoutingSection />)
    fireEvent.change(
      screen.getByLabelText("providerId", { selector: "#difficulty-weak-provider" }),
      {
        target: { value: "" },
      }
    )
    expect(saveMock).toHaveBeenCalledWith({
      difficultyRouting: expect.objectContaining({ weakModel: undefined }),
    })
  })

  it("persists the threshold within range only", () => {
    settingsState = { difficultyRouting: { enabled: true, threshold: 0.5 } }
    render(<DifficultyRoutingSection />)
    fireEvent.change(screen.getByLabelText("threshold"), { target: { value: "0.8" } })
    expect(saveMock).toHaveBeenCalledWith({
      difficultyRouting: expect.objectContaining({ threshold: 0.8 }),
    })
  })
})
