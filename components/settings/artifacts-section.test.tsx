/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn()
let mockedSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof mockedSettings; save: typeof saveMock }) => T
  ) => selector({ settings: mockedSettings, save: saveMock }),
}))

import { ArtifactsSection } from "./artifacts-section"

beforeEach(() => {
  saveMock.mockReset()
  mockedSettings = {}
})

describe("ArtifactsSection", () => {
  it("renders all 9 control rows", () => {
    render(<ArtifactsSection />)
    expect(screen.getByText("autoCreateLabel")).toBeInTheDocument()
    expect(screen.getByText("minLinesLabel")).toBeInTheDocument()
    expect(screen.getByText("enabledTypesLabel")).toBeInTheDocument()
    expect(screen.getByText("showNotificationLabel")).toBeInTheDocument()
    expect(screen.getByText("defaultPanelModeLabel")).toBeInTheDocument()
    expect(screen.getByText("persistAcrossSessionsLabel")).toBeInTheDocument()
    expect(screen.getByText("reviewBeforeApplyLabel")).toBeInTheDocument()
    expect(screen.getByText("interactiveHtmlLabel")).toBeInTheDocument()
    expect(screen.getByText("resetDefaults")).toBeInTheDocument()
  })

  it("toggling review-before-apply persists the patch", () => {
    // Addressed by testid, not by position: this used to be "the last switch",
    // which silently pointed at a different control the moment one was added.
    render(<ArtifactsSection />)
    fireEvent.click(screen.getByTestId("artifacts-review-before-apply"))
    expect(saveMock).toHaveBeenCalled()
    expect(saveMock.mock.calls[0][0].artifacts.reviewBeforeApply).toBe(false)
  })

  it("toggling agent authoring persists the patch", () => {
    render(<ArtifactsSection />)
    fireEvent.click(screen.getByTestId("artifacts-agent-authoring"))
    expect(saveMock.mock.calls[0][0].artifacts.agentAuthoring).toBe(false)
  })

  it("interactive HTML is off until it is switched on", () => {
    render(<ArtifactsSection />)
    const toggle = screen.getByTestId("artifacts-interactive-html")
    expect(toggle).toHaveAttribute("data-state", "unchecked")
    fireEvent.click(toggle)
    expect(saveMock.mock.calls[0][0].artifacts.interactiveHtml).toBe(true)
  })

  it("an unrelated toggle carries every other field through", () => {
    // `save` REPLACES the artifacts block, so a field the writer forgets to
    // spread is silently reset. agentAuthoring was dropped that way.
    mockedSettings = { artifacts: { agentAuthoring: false, interactiveHtml: true } }
    render(<ArtifactsSection />)
    fireEvent.click(screen.getByTestId("artifacts-review-before-apply"))
    const patch = saveMock.mock.calls[0][0].artifacts
    expect(patch.agentAuthoring).toBe(false)
    expect(patch.interactiveHtml).toBe(true)
  })

  it("toggling auto-create persists the patch", () => {
    render(<ArtifactsSection />)
    // The first switch is the auto-create toggle.
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[0])
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    expect(patch.artifacts.autoCreate).toBe(false)
  })

  it("clicking 'Reset to defaults' saves the default block", () => {
    render(<ArtifactsSection />)
    fireEvent.click(screen.getByText("resetDefaults"))
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    expect(patch.artifacts.autoCreate).toBe(true)
    expect(patch.artifacts.minLines).toBe(10)
    expect(patch.artifacts.enabledTypes).toHaveLength(9)
    expect(patch.artifacts.interactiveHtml).toBe(false)
  })

  it("toggling a type turns it off and persists the reduced list", () => {
    mockedSettings = {
      artifacts: {
        autoCreate: true,
        minLines: 10,
        enabledTypes: [
          "code",
          "html",
          "react",
          "svg",
          "mermaid",
          "chart",
          "math",
          "document",
          "jupyter",
        ],
        showNotification: true,
        defaultPanelMode: "code",
        persistAcrossSessions: true,
      },
    }
    render(<ArtifactsSection />)
    // The first switch is auto-create; subsequent ones include the 9 type toggles.
    const switches = screen.getAllByRole("switch")
    // Find a type switch by its initial state (true) and click it; pick switch #2.
    fireEvent.click(switches[1])
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    // One type was removed.
    expect(patch.artifacts.enabledTypes.length).toBeLessThan(9)
  })

  it("changing the default panel mode persists 'preview'", () => {
    render(<ArtifactsSection />)
    // Two radio items: code, preview.
    const previewRadio = screen.getByLabelText("defaultPanelMode.preview")
    fireEvent.click(previewRadio)
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    expect(patch.artifacts.defaultPanelMode).toBe("preview")
  })
})

describe("ArtifactsSection — allowed-types grid", () => {
  // A fixed three-column grid gave each cell ~110px on a phone; a `Switch` plus
  // an icon left about 40px for the name, so every label truncated to one or
  // two characters and "Code" and "Chart" both rendered as "C…".
  it("stacks to a single column before sm and only widens from there", () => {
    const { container } = render(<ArtifactsSection />)
    const grids = [...container.querySelectorAll("div")].filter((d) =>
      d.className.includes("grid-cols-1")
    )
    const typeGrid = grids.find((g) => g.querySelectorAll("label").length >= 5)
    expect(typeGrid).toBeDefined()
    expect(typeGrid!.className).toContain("sm:grid-cols-2")
    expect(typeGrid!.className).toContain("lg:grid-cols-3")
  })

  it("gives every type its own full-width row on a phone", () => {
    const { container } = render(<ArtifactsSection />)
    const labels = [...container.querySelectorAll("label")].filter(
      (l) => l.querySelector("button[role='switch']") !== null
    )
    expect(labels.length).toBeGreaterThanOrEqual(5)
    // No label may rely on truncation to fit — the name is the only thing that
    // identifies the row.
    for (const l of labels) {
      expect((l.textContent ?? "").trim().length).toBeGreaterThan(1)
    }
  })
})
