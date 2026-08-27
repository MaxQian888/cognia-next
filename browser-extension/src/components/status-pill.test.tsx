/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import type { BrowserSubmissionStatus } from "@cognia/companion-client"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { StatusPill } from "./status-pill"

const api = { message: (key: string) => key } as BrowserApi

const ALL: BrowserSubmissionStatus[] = [
  "submitting",
  "queued",
  "running",
  "needs_input",
  "completed",
  "cancelled",
  "failed",
  "host_unavailable",
]

describe("StatusPill", () => {
  it("has a label for every status the protocol can send", () => {
    // A missing arm would render `undefined` in a chip, which reads as a bug
    // in the task rather than a gap in the panel.
    for (const status of ALL) {
      const { unmount } = render(<StatusPill api={api} status={status} />)
      expect(screen.getByTestId(`status-${status}`)).not.toBeEmptyDOMElement()
      unmount()
    }
  })

  it("never shows the protocol's own words", () => {
    // `needs_input` reads as an error and is not; `host_unavailable` names an
    // enum member nobody has a mental model for.
    for (const status of ALL) {
      const { unmount } = render(<StatusPill api={api} status={status} />)
      expect(screen.getByTestId(`status-${status}`).textContent).not.toBe(status)
      unmount()
    }
  })

  it("uses the shared Badge, so a style pack squares it with everything else", () => {
    render(<StatusPill api={api} status="running" />)
    // `data-slot="badge"` is the app component's own marker: its presence is
    // what proves this is the shared primitive rather than a look-alike.
    expect(screen.getByTestId("status-running")).toHaveAttribute("data-slot", "badge")
  })
})
