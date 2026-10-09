import { render, screen, within } from "@testing-library/react"

jest.mock("./radar-panel", () => ({ RadarPanel: () => <div data-testid="radar-panel" /> }))
jest.mock("@/components/capture/capture-settings-panel", () => ({
  CaptureSettingsPanel: () => <div data-testid="capture-settings" />,
}))

import { InsightsTab } from "./insights-tab"

describe("InsightsTab", () => {
  it("frames the capture settings under their own heading below the radar", () => {
    render(<InsightsTab />)
    const tab = screen.getByTestId("pet-insights-tab")
    expect(within(tab).getByTestId("radar-panel")).toBeInTheDocument()
    const section = screen
      .getByRole("heading", { name: /capture/i })
      .closest("section") as HTMLElement
    expect(within(section).getByTestId("capture-settings")).toBeInTheDocument()
    // The radar comes first; the capture section explains what it feeds.
    expect(
      screen.getByTestId("radar-panel").compareDocumentPosition(section) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(within(section).getByText(/radar/i)).toBeInTheDocument()
  })
})
