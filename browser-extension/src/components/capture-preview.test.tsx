/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import { BROWSER_CONTEXT_LIMITS } from "@cognia/companion-client"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import type { CapturedPage } from "@ext/src/lib/panel-state"
import { CapturePreview } from "./capture-preview"

const api = {
  message: (key: string, subs?: string[]) => (subs ? `${key}:${subs.join(",")}` : key),
} as BrowserApi

function page(overrides: Partial<CapturedPage> = {}): CapturedPage {
  return {
    tabId: 1,
    title: "A guide",
    url: "https://example.com/docs",
    rawUrl: "https://example.com/docs?utm=x",
    selection: { text: "the selected sentence", truncated: false },
    readableText: null,
    capturedAt: 1,
    strippedQuery: true,
    ...overrides,
  }
}

function renderPreview(overrides: Partial<CapturedPage> = {}, extra = {}) {
  return render(
    <CapturePreview
      api={api}
      page={page(overrides)}
      mode="selection"
      limits={BROWSER_CONTEXT_LIMITS}
      includeFullUrl={false}
      onToggleFullUrl={jest.fn()}
      {...extra}
    />
  )
}

describe("CapturePreview", () => {
  it("shows the address that will actually be sent", () => {
    // This is the consent mechanism: the user is agreeing to this exact
    // string, not to whatever the tab's address bar shows.
    renderPreview()
    expect(screen.getByTestId("capture-url")).toHaveTextContent("https://example.com/docs")
    expect(screen.getByTestId("capture-url")).not.toHaveTextContent("utm")
  })

  it("states the size of what is being sent", () => {
    renderPreview()
    expect(screen.getByTestId("capture-bytes")).toBeInTheDocument()
  })

  it("says so when something was cut, and stays quiet when nothing was", () => {
    // "the agent read the whole page" and "the agent read the first 128 KiB"
    // are different claims, and the user is the one making them.
    const cut = renderPreview({ selection: { text: "clipped", truncated: true } })
    expect(screen.getByTestId("capture-truncated")).toBeInTheDocument()
    // Unmounted before the second render: `screen` queries the whole document,
    // so a leftover tree would make the negative assertion below pass or fail
    // for the wrong reason.
    cut.unmount()

    renderPreview()
    expect(screen.queryByTestId("capture-truncated")).toBeNull()
  })

  it("offers the full address only when there is something to add back", () => {
    // A checkbox that changes nothing invites the user to think about a
    // decision they do not have.
    const offered = renderPreview()
    expect(screen.getByTestId("capture-full-url")).toBeInTheDocument()
    offered.unmount()

    renderPreview({ strippedQuery: false })
    expect(screen.queryByTestId("capture-full-url")).toBeNull()
  })

  it("reports the full-address choice back to the caller", () => {
    const onToggleFullUrl = jest.fn()
    renderPreview({}, { onToggleFullUrl })
    fireEvent.click(screen.getByTestId("capture-full-url"))
    expect(onToggleFullUrl).toHaveBeenCalledWith(true)
  })

  it("names the capture mode in the panel's words", () => {
    renderPreview()
    expect(screen.getByText("captureModeSelection")).toBeInTheDocument()
  })

  it("falls back to the address when a page has no title", () => {
    renderPreview({ title: "" })
    expect(screen.getAllByText("https://example.com/docs").length).toBeGreaterThan(0)
  })
})
