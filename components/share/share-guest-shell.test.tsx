/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { ShareGuestShell, useShareViewerIsGuest } from "./share-guest-shell"

function GuestProbe() {
  return <p data-testid="probe">{String(useShareViewerIsGuest())}</p>
}

describe("ShareGuestShell", () => {
  it("tells the page it is rendering for a guest", () => {
    render(
      <ShareGuestShell>
        <GuestProbe />
      </ShareGuestShell>
    )
    expect(screen.getByTestId("probe")).toHaveTextContent("true")
    expect(screen.getByTestId("share-guest-shell")).toContainElement(screen.getByTestId("probe"))
  })

  // The in-app copy of the route renders under the full runtime, with no shell
  // around it, and must keep reading the account's own settings.
  it("reads as not-a-guest outside the shell", () => {
    render(<GuestProbe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("false")
  })

  // The payload renderers use tooltips, and Radix refuses to mount a tooltip
  // without its provider. The full runtime supplies one; the guest shell has
  // to supply its own.
  it("provides the tooltip context the payload renderers need", () => {
    expect(() =>
      render(
        <ShareGuestShell>
          <Tooltip>
            <TooltipTrigger>trigger</TooltipTrigger>
            <TooltipContent>tip</TooltipContent>
          </Tooltip>
        </ShareGuestShell>
      )
    ).not.toThrow()
    expect(screen.getByText("trigger")).toBeInTheDocument()
  })

  // Copy feedback and similar notices from the payload renderers are toasts.
  // The full runtime mounts its Toaster below the gate, out of this shell's
  // reach, so without its own a guest's toasts would go nowhere. (Sonner is
  // stubbed in Jest; the stub is the mounted Toaster.)
  it("mounts a toaster for the page's notices", () => {
    render(
      <ShareGuestShell>
        <p>page</p>
      </ShareGuestShell>
    )
    expect(screen.getByTestId("toaster")).toBeInTheDocument()
  })
})
