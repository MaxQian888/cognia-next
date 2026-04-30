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
  it("renders all 7 control rows", () => {
    render(<ArtifactsSection />)
    expect(screen.getByText("autoCreateLabel")).toBeInTheDocument()
    expect(screen.getByText("minLinesLabel")).toBeInTheDocument()
    expect(screen.getByText("enabledTypesLabel")).toBeInTheDocument()
    expect(screen.getByText("showNotificationLabel")).toBeInTheDocument()
    expect(screen.getByText("defaultPanelModeLabel")).toBeInTheDocument()
    expect(screen.getByText("persistAcrossSessionsLabel")).toBeInTheDocument()
    expect(screen.getByText("resetDefaults")).toBeInTheDocument()
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
