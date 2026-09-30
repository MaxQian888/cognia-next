import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip"

const originalMatchMedia = window.matchMedia

/** A matchMedia that matches exactly the queries in `truthy`. */
function installMatchMedia(truthy: string[]): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: truthy.includes(query),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  })
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
})

function Harness({ open }: { open?: boolean }) {
  return (
    <TooltipProvider>
      <Tooltip {...(open === undefined ? {} : { open })}>
        <TooltipTrigger asChild>
          <button type="button">Attach</button>
        </TooltipTrigger>
        <TooltipContent>Add attachment</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

describe("Tooltip", () => {
  it("opens on hover where the pointer can hover", async () => {
    installMatchMedia(["(hover: hover)"])
    const user = userEvent.setup()
    render(<Harness />)
    await user.hover(screen.getByRole("button", { name: "Attach" }))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Add attachment")
  })

  it("stays closed on a device that cannot hover, even when a tap focuses the trigger", async () => {
    installMatchMedia(["(hover: none)", "(pointer: coarse)"])
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole("button", { name: "Attach" })
    await user.hover(trigger)
    act(() => trigger.focus())
    await user.click(trigger)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  it("still honours an explicitly controlled open state on a touch device", () => {
    installMatchMedia(["(hover: none)", "(pointer: coarse)"])
    render(<Harness open />)
    expect(screen.getByRole("tooltip")).toHaveTextContent("Add attachment")
  })
})
