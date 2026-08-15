/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { BrowserDevtoolsDrawer } from "./browser-devtools-drawer"

const consoleEntries = [
  { level: "log" as const, text: "hello", ts: 1 },
  { level: "error" as const, text: "boom", ts: 2 },
]
const network = [
  { url: "https://x/ok", method: "GET", status: 200, ok: true, durationMs: 12 },
  { url: "https://x/bad", method: "POST", status: 503, ok: false, durationMs: null },
]

describe("BrowserDevtoolsDrawer (ADR-0127)", () => {
  it("starts collapsed with badges, expands to the console tab and clears the active stream", () => {
    const onClearConsole = jest.fn()
    const onClearNetwork = jest.fn()
    const onLayoutChange = jest.fn()
    jest.useFakeTimers()
    render(
      <BrowserDevtoolsDrawer
        console={consoleEntries}
        network={network}
        problemCount={1}
        failedRequests={1}
        onClearConsole={onClearConsole}
        onClearNetwork={onClearNetwork}
        onLayoutChange={onLayoutChange}
      />
    )
    expect(screen.getByTestId("browser-devtools-drawer")).toHaveAttribute("data-expanded", "false")
    expect(screen.getByTestId("browser-devtools-problems")).toHaveTextContent("1 problem")
    expect(screen.getByTestId("browser-devtools-failed")).toHaveTextContent("1 failed request")
    expect(screen.queryByTestId("browser-devtools-console")).toBeNull()

    fireEvent.click(screen.getByTestId("browser-devtools-toggle"))
    jest.runOnlyPendingTimers()
    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    const list = screen.getByTestId("browser-devtools-console")
    expect(list.querySelectorAll("li")).toHaveLength(2)
    expect(list.querySelector('li[data-level="error"]')).toHaveTextContent("boom")

    fireEvent.click(screen.getByTestId("browser-devtools-clear"))
    expect(onClearConsole).toHaveBeenCalledTimes(1)
    expect(onClearNetwork).not.toHaveBeenCalled()
    jest.useRealTimers()
  })

  it("switches to the network tab and clears that stream instead", () => {
    const onClearConsole = jest.fn()
    const onClearNetwork = jest.fn()
    render(
      <BrowserDevtoolsDrawer
        console={[]}
        network={network}
        problemCount={0}
        failedRequests={1}
        onClearConsole={onClearConsole}
        onClearNetwork={onClearNetwork}
      />
    )
    fireEvent.click(screen.getByTestId("browser-devtools-toggle"))
    expect(screen.getByText("No console output captured yet.")).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Network/ }))
    fireEvent.click(screen.getByRole("tab", { name: /Network/ }))
    const list = screen.getByTestId("browser-devtools-network")
    expect(list.querySelectorAll("li")).toHaveLength(2)
    expect(list.querySelector('li[data-ok="false"]')).toHaveTextContent("503")
    expect(list).toHaveTextContent("12 ms")
    fireEvent.click(screen.getByTestId("browser-devtools-clear"))
    expect(onClearNetwork).toHaveBeenCalledTimes(1)
    expect(onClearConsole).not.toHaveBeenCalled()
  })
})
