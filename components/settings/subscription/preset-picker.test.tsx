/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async (_: unknown) => undefined)
const mockState: { preset: { id: string; label: string; baseUrl: string } | null } = {
  preset: { id: "p1", label: "AWS Bedrock", baseUrl: "https://example.com" },
}

jest.mock("@/lib/subscription/core/hooks", () => ({
  useProviderPreset: () => ({
    preset: mockState.preset,
    loading: false,
    save: (next: unknown) => saveMock(next),
  }),
}))

jest.mock("@/lib/subscription/core/uuidv7", () => ({
  uuidv7: () => "uuid-test",
}))

import { PresetPicker } from "./preset-picker"

beforeEach(() => {
  saveMock.mockClear()
  mockState.preset = { id: "p1", label: "AWS Bedrock", baseUrl: "https://example.com" }
})

describe("PresetPicker", () => {
  it("renders the SelectablePresetCard with the active preset's label", () => {
    render(<PresetPicker provider="anthropic" />)
    expect(screen.getByText("AWS Bedrock")).toBeInTheDocument()
    expect(screen.getByTestId("selectable-preset-card-badge")).toHaveTextContent("presetActive")
  })

  it("shows the inactive card when no preset is configured", () => {
    mockState.preset = null
    render(<PresetPicker provider="anthropic" />)
    expect(screen.getByText("noPreset")).toBeInTheDocument()
    expect(screen.getByTestId("selectable-preset-card-badge")).toHaveTextContent("presetInactive")
  })

  it("opens the remove confirmation dialog when Remove is clicked", () => {
    render(<PresetPicker provider="anthropic" />)
    fireEvent.click(screen.getByText("removePreset"))
    expect(screen.getByText("removeConfirmTitle")).toBeInTheDocument()
  })

  it("invokes save(null) only after the user confirms removal", async () => {
    render(<PresetPicker provider="anthropic" />)
    fireEvent.click(screen.getByText("removePreset"))
    // Confirm action — find the AlertDialog action with removePreset label.
    const dialogActions = screen.getAllByText("removePreset")
    // The second instance is the action button inside the dialog footer.
    fireEvent.click(dialogActions[dialogActions.length - 1])
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(null)
    })
  })

  it("does not invoke save when the user cancels the remove dialog", () => {
    render(<PresetPicker provider="anthropic" />)
    fireEvent.click(screen.getByText("removePreset"))
    fireEvent.click(screen.getByText("cancel"))
    expect(saveMock).not.toHaveBeenCalled()
  })
})
