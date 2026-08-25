/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { BrowserConsolePanel, BrowserNetworkPanel } from "./browser-devtools-panels"

const consoleEntries = [
  { level: "log" as const, text: "hello", ts: 1 },
  { level: "error" as const, text: "boom", ts: 2 },
]
const network = [
  { url: "https://x/ok", method: "GET", status: 200, ok: true, durationMs: 12 },
  { url: "https://x/bad", method: "POST", status: 503, ok: false, durationMs: null },
]

describe("BrowserConsolePanel (ADR-0127)", () => {
  it("lists entries with their level and clears on request", () => {
    const onClear = jest.fn()
    render(<BrowserConsolePanel entries={consoleEntries} onClear={onClear} />)
    const list = screen.getByTestId("browser-devtools-console")
    expect(list).toHaveTextContent("hello")
    expect(list).toHaveTextContent("boom")
    expect(list.querySelector('[data-level="error"]')).not.toBeNull()

    fireEvent.click(screen.getByTestId("browser-devtools-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("says so when nothing has been captured", () => {
    render(<BrowserConsolePanel entries={[]} onClear={jest.fn()} />)
    expect(screen.queryByTestId("browser-devtools-console")).toBeNull()
    expect(screen.getByText("No console output captured yet.")).toBeInTheDocument()
  })
})

describe("BrowserNetworkPanel (ADR-0127)", () => {
  it("marks failed requests and renders a duration when there is one", () => {
    render(<BrowserNetworkPanel entries={network} onClear={jest.fn()} />)
    const list = screen.getByTestId("browser-devtools-network")
    expect(list.querySelector('[data-ok="false"]')).not.toBeNull()
    expect(list).toHaveTextContent("https://x/ok")
    expect(list).toHaveTextContent("503")
    // `durationMs: null` must not render an empty "ms" row.
    expect(list.querySelectorAll("li")[1]?.textContent).not.toContain("ms")
  })

  it("clears on request", () => {
    const onClear = jest.fn()
    render(<BrowserNetworkPanel entries={network} onClear={onClear} />)
    fireEvent.click(screen.getByTestId("browser-devtools-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("says so when nothing has been captured", () => {
    render(<BrowserNetworkPanel entries={[]} onClear={jest.fn()} />)
    expect(screen.queryByTestId("browser-devtools-network")).toBeNull()
    expect(screen.getByText("No requests captured yet.")).toBeInTheDocument()
  })
})
