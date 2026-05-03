/** @jest-environment jsdom */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { RemoteControlSection } from "./remote-control-section"

jest.mock("./tabs", () => ({
  OverviewTab: () => <div data-testid="tab-overview" />,
  InboundTab: () => <div data-testid="tab-inbound" />,
  OutboundTab: () => <div data-testid="tab-outbound" />,
  EventsTab: () => <div data-testid="tab-events" />,
}))

const routerReplace = jest.fn()
let currentSearch = ""
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: (href: string) => {
      routerReplace(href)
      const qIdx = href.indexOf("?")
      currentSearch = qIdx >= 0 ? href.slice(qIdx) : ""
    },
    back: jest.fn(),
  }),
  useSearchParams: () =>
    new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch),
}))

beforeEach(() => {
  routerReplace.mockReset()
  currentSearch = ""
})

describe("RemoteControlSection", () => {
  it("renders Overview by default", () => {
    render(<RemoteControlSection />)
    expect(screen.getByTestId("tab-overview")).toBeInTheDocument()
  })

  it("hydrates the active tab from ?remoteControlTab= on first render", () => {
    currentSearch = "?remoteControlTab=outbound"
    render(<RemoteControlSection />)
    expect(screen.getByTestId("tab-outbound")).toBeInTheDocument()
  })

  it("falls back to overview when the URL param is unknown", () => {
    currentSearch = "?remoteControlTab=garbage"
    render(<RemoteControlSection />)
    expect(screen.getByTestId("tab-overview")).toBeInTheDocument()
  })

  it("switches tabs on click and writes the URL param", async () => {
    const { rerender } = render(<RemoteControlSection />)
    // Radix Tabs trigger acts on pointerDown for activation, then click for
    // commit. fireEvent.click alone does not fire the underlying pointer
    // events, so we send the full sequence to drive the tab change.
    const inboundTab = screen.getByRole("tab", { name: /inbound/i })
    await act(async () => {
      fireEvent.pointerDown(inboundTab, { button: 0, ctrlKey: false })
      fireEvent.mouseDown(inboundTab, { button: 0 })
      fireEvent.click(inboundTab)
    })
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("remoteControlTab=inbound")
      )
    )
    rerender(<RemoteControlSection />)
    await waitFor(() => expect(screen.getByTestId("tab-inbound")).toBeInTheDocument())

    const eventsTab = screen.getByRole("tab", { name: /events/i })
    await act(async () => {
      fireEvent.pointerDown(eventsTab, { button: 0, ctrlKey: false })
      fireEvent.mouseDown(eventsTab, { button: 0 })
      fireEvent.click(eventsTab)
    })
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith(expect.stringContaining("remoteControlTab=events"))
    )
    rerender(<RemoteControlSection />)
    await waitFor(() => expect(screen.getByTestId("tab-events")).toBeInTheDocument())
  })
})
