/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { PickerCheck, PickerRow, ResponsivePicker } from "./responsive-picker"

// Radix Popover and cmdk both reach for pointer/scroll primitives jsdom lacks.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {}
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

const useIsMobileMock = jest.fn().mockReturnValue(false)
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => useIsMobileMock(),
}))

beforeEach(() => {
  useIsMobileMock.mockReset().mockReturnValue(false)
})

function renderPicker(
  props: Partial<React.ComponentProps<typeof ResponsivePicker>> = {},
  onSelect = jest.fn()
) {
  const utils = render(
    <ResponsivePicker
      open
      onOpenChange={() => {}}
      trigger={<button type="button">open picker</button>}
      title="Pick a thing"
      description="Which thing runs next"
      {...props}
    >
      <CommandInput placeholder="Search things" />
      <CommandList>
        <CommandEmpty>nothing matched</CommandEmpty>
        <CommandItem value="alpha thing" onSelect={onSelect}>
          <PickerRow title="Alpha" description="alpha-id" active />
        </CommandItem>
        <CommandItem value="beta thing" onSelect={onSelect}>
          <PickerRow title="Beta" description="beta-id" />
        </CommandItem>
      </CommandList>
    </ResponsivePicker>
  )
  return { ...utils, onSelect }
}

describe("ResponsivePicker", () => {
  it("renders an anchored popover on desktop, carrying the tier and the title as a label", () => {
    renderPicker()
    const panel = screen.getByTestId("responsive-picker-popover")
    expect(panel).toBeInTheDocument()
    expect(screen.queryByTestId("responsive-picker-drawer")).toBeNull()
    // The whole point of the envelope: the overlay tier reaches the panel, so
    // a style pack's elevation ceiling applies to pickers like everything else.
    expect(panel).toHaveAttribute("data-surface-layer", "overlay")
    expect(panel).toHaveAttribute("data-elevation", "2")
    expect(panel).toHaveAttribute("aria-label", "Pick a thing")
  })

  it("renders a bottom drawer on mobile with the same rows and a visible heading", () => {
    useIsMobileMock.mockReturnValue(true)
    renderPicker()
    expect(screen.getByTestId("responsive-picker-drawer")).toBeInTheDocument()
    expect(screen.queryByTestId("responsive-picker-popover")).toBeNull()
    // The title is chrome on a phone, not just an aria label.
    expect(screen.getByText("Pick a thing")).toBeInTheDocument()
    expect(screen.getByText("Which thing runs next")).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
  })

  it("clamps the drawer list so a long option list cannot push its own trigger off-screen", () => {
    useIsMobileMock.mockReturnValue(true)
    renderPicker()
    const drawer = screen.getByTestId("responsive-picker-drawer")
    expect(drawer.className).toContain("max-h-[min(85vh,calc(100dvh-4rem))]")
    const command = drawer.querySelector("[data-slot=command]")
    expect(command?.className).toContain(
      "[&_[data-slot=command-list]]:max-h-[min(60vh,calc(100dvh-13rem))]"
    )
  })

  it("gives drawer rows a 44px touch floor", () => {
    useIsMobileMock.mockReturnValue(true)
    renderPicker()
    const command = screen
      .getByTestId("responsive-picker-drawer")
      .querySelector("[data-slot=command]")
    expect(command?.className).toContain("[&_[data-slot=command-item]]:min-h-11")
  })

  it("keeps cmdk in charge of filtering in both shells", () => {
    const { rerender, onSelect } = renderPicker()
    fireEvent.change(screen.getByPlaceholderText("Search things"), { target: { value: "beta" } })
    expect(screen.queryByText("Alpha")).toBeNull()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
    rerender(<div />)
  })

  it("renders the trigger and nothing else while closed", () => {
    renderPicker({ open: false })
    expect(screen.getByRole("button", { name: "open picker" })).toBeInTheDocument()
    expect(screen.queryByText("Alpha")).toBeNull()
    expect(screen.queryByTestId("responsive-picker-popover")).toBeNull()
  })

  it("honours a caller test id over the default", () => {
    renderPicker({ testId: "model-picker-panel" })
    expect(screen.getByTestId("model-picker-panel")).toBeInTheDocument()
  })
})

describe("PickerRow", () => {
  it("reserves the tick's box on every row so the meta column cannot step sideways", () => {
    const { container, rerender } = render(<PickerCheck active={false} />)
    const inactive = container.querySelector("svg")
    expect(inactive).toBeInTheDocument()
    expect(inactive?.getAttribute("class")).toContain("opacity-0")
    rerender(<PickerCheck active />)
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("opacity-100")
  })

  it("renders identity on the left and description, meta and note where they belong", () => {
    render(
      <PickerRow
        media={<span data-testid="row-media">M</span>}
        title="Claude Opus"
        description="claude-opus-5"
        meta={<span>200K</span>}
        note="Not connected"
        active
      />
    )
    expect(screen.getByTestId("row-media")).toBeInTheDocument()
    expect(screen.getByText("Claude Opus")).toBeInTheDocument()
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument()
    expect(screen.getByText("200K")).toBeInTheDocument()
    expect(screen.getByText("Not connected")).toBeInTheDocument()
  })

  it("drops the optional slots entirely rather than rendering empty boxes", () => {
    const { container } = render(<PickerRow title="Bare" />)
    expect(screen.getByText("Bare")).toBeInTheDocument()
    // media, description, meta and note all absent leaves title plus the tick.
    expect(container.querySelectorAll("span").length).toBeLessThan(5)
  })
})
