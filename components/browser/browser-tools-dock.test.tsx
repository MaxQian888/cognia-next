/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BrowserToolsDock } from "./browser-tools-dock"

const panels = {
  recorder: <div data-testid="panel-recorder">recorder body</div>,
  console: <div data-testid="panel-console">console body</div>,
  network: <div data-testid="panel-network">network body</div>,
}

const counts = {
  consoleCount: 0,
  networkCount: 0,
  problemCount: 0,
  failedRequests: 0,
}

describe("BrowserToolsDock", () => {
  it("starts collapsed, so an idle pane spends one row on chrome", () => {
    render(<BrowserToolsDock {...panels} {...counts} />)
    expect(screen.getByTestId("browser-tools-dock")).toHaveAttribute("data-expanded", "false")
    expect(screen.queryByTestId("panel-recorder")).toBeNull()
    expect(screen.queryByTestId("panel-console")).toBeNull()
  })

  it("expands to the recorder and switches between tools", async () => {
    const user = userEvent.setup()
    render(<BrowserToolsDock {...panels} {...counts} />)
    fireEvent.click(screen.getByTestId("browser-tools-toggle"))
    expect(screen.getByTestId("panel-recorder")).toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: /Network/ }))
    expect(screen.getByTestId("browser-tools-dock")).toHaveAttribute("data-tab", "network")
    expect(screen.getByTestId("panel-network")).toBeInTheDocument()
    expect(screen.queryByTestId("panel-recorder")).toBeNull()
  })

  // The native webview floats above React and is positioned from a measured
  // rect, so anything that changes this strip's height has to say so.
  it("reports every layout change so the webview can be re-measured", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    jest.useFakeTimers()
    try {
      const onLayoutChange = jest.fn()
      render(<BrowserToolsDock {...panels} {...counts} onLayoutChange={onLayoutChange} />)

      fireEvent.click(screen.getByTestId("browser-tools-toggle"))
      jest.runOnlyPendingTimers()
      expect(onLayoutChange).toHaveBeenCalledTimes(1)

      await user.click(screen.getByRole("tab", { name: /Console/ }))
      jest.runOnlyPendingTimers()
      expect(onLayoutChange).toHaveBeenCalledTimes(2)

      fireEvent.click(screen.getByTestId("browser-tools-toggle"))
      jest.runOnlyPendingTimers()
      expect(onLayoutChange).toHaveBeenCalledTimes(3)
    } finally {
      jest.useRealTimers()
    }
  })

  it("shows badges while collapsed so the dock says why it is worth opening", () => {
    render(
      <BrowserToolsDock
        {...panels}
        consoleCount={3}
        networkCount={4}
        problemCount={2}
        failedRequests={1}
        recordingSteps={7}
      />
    )
    expect(screen.getByTestId("browser-devtools-problems")).toHaveTextContent("2 problems")
    expect(screen.getByTestId("browser-devtools-failed")).toHaveTextContent("1 failed request")
    expect(screen.getByTestId("browser-tools-recording")).toHaveTextContent("7")
    expect(screen.getByRole("tab", { name: /Console \(3\)/ })).toBeInTheDocument()
  })

  it("hides the developer tab when there is no panel for it", () => {
    render(<BrowserToolsDock {...panels} {...counts} />)
    expect(screen.queryByRole("tab", { name: "Developer" })).toBeNull()
  })

  it("opens at a requested tab, and again on a repeat request", () => {
    const developer = <div data-testid="panel-developer">developer body</div>
    const { rerender } = render(<BrowserToolsDock {...panels} {...counts} developer={developer} />)
    expect(screen.getByTestId("browser-tools-dock")).toHaveAttribute("data-expanded", "false")

    rerender(
      <BrowserToolsDock
        {...panels}
        {...counts}
        developer={developer}
        openRequest={{ tab: "developer", nonce: 1 }}
      />
    )
    expect(screen.getByTestId("panel-developer")).toBeInTheDocument()

    // Collapse by hand, then ask again with the SAME tab: a nonce is what makes
    // the repeat land, since the requested tab never changes.
    fireEvent.click(screen.getByTestId("browser-tools-toggle"))
    expect(screen.queryByTestId("panel-developer")).toBeNull()
    rerender(
      <BrowserToolsDock
        {...panels}
        {...counts}
        developer={developer}
        openRequest={{ tab: "developer", nonce: 2 }}
      />
    )
    expect(screen.getByTestId("panel-developer")).toBeInTheDocument()
  })
})
