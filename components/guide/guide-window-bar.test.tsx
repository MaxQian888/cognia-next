/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

const chromeMode = { value: "none" as "none" | "traffic-lights" | "buttons" }
jest.mock("@/components/desktop/window-controls", () => ({
  useWindowChromeMode: () => chromeMode.value,
  WindowControls: () => <div data-testid="window-controls" />,
}))

import { GuideWindowBar } from "./guide-window-bar"

beforeEach(() => {
  chromeMode.value = "none"
})

describe("GuideWindowBar", () => {
  it("prefixes its hooks so each flow keeps its own", () => {
    render(
      <GuideWindowBar
        wordmark="Cognia"
        testIdPrefix="pair"
        back={{ onBack: () => {}, label: "Back" }}
      />
    )
    expect(screen.getByTestId("pair-window-bar")).toBeInTheDocument()
    expect(screen.getByTestId("pair-back")).toBeInTheDocument()
  })

  it("carries the wordmark and the platform's window controls", () => {
    render(<GuideWindowBar wordmark="Cognia" testIdPrefix="x" />)
    expect(screen.getByText("Cognia")).toBeInTheDocument()
    expect(screen.getByTestId("window-controls")).toBeInTheDocument()
  })

  it("is a drag region, since guided routes suppress the title bar", () => {
    render(<GuideWindowBar wordmark="Cognia" testIdPrefix="x" />)
    expect(screen.getByTestId("x-window-bar")).toHaveAttribute("data-tauri-drag-region")
  })

  it("reserves room for the macOS traffic lights", () => {
    chromeMode.value = "traffic-lights"
    render(<GuideWindowBar wordmark="Cognia" testIdPrefix="x" />)
    expect(screen.getByTestId("x-window-bar")).toHaveClass("pl-22")
  })

  it("names Back for assistive tech and disables it while busy", () => {
    const onBack = jest.fn()
    render(
      <GuideWindowBar wordmark="Cognia" testIdPrefix="x" back={{ onBack, label: "Go back" }} busy />
    )
    const back = screen.getByRole("button", { name: "Go back" })
    expect(back).toBeDisabled()
    fireEvent.click(back)
    expect(onBack).not.toHaveBeenCalled()
  })

  it("omits Back entirely when there is nowhere to go", () => {
    render(<GuideWindowBar wordmark="Cognia" testIdPrefix="x" />)
    expect(screen.queryByTestId("x-back")).toBeNull()
  })
})
