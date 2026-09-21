jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

import { fireEvent, render, screen } from "@testing-library/react"
import { GlobeIcon } from "lucide-react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CapabilityRow } from "./capability-row"
import { usePlatform } from "@/hooks/use-platform"

const platformMock = usePlatform as jest.Mock

beforeEach(() => {
  platformMock.mockReturnValue("web")
})

describe("CapabilityRow", () => {
  it("renders the desktop menu-row anatomy and fires onClick", () => {
    const onClick = jest.fn()
    render(<CapabilityRow icon={<GlobeIcon className="size-4" />} label="Web" onClick={onClick} />)

    const row = screen.getByRole("button", { name: "Web" })
    fireEvent.click(row)

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(row.className).toContain("w-full")
    expect(row.className).toContain("text-sm")
    expect(row.className).toContain("hover:bg-accent")
  })

  it("marks an on row with the active dot", () => {
    render(<CapabilityRow icon={<i />} label="Web" active />)
    expect(screen.getByRole("button").querySelector(".bg-primary")).not.toBeNull()
  })

  it("uses the touch-sized row and shows the hint line on mobile", () => {
    platformMock.mockReturnValue("mobile")
    render(<CapabilityRow icon={<i />} label="Web" hint="Configure a provider first" />)

    const row = screen.getByRole("menuitem")
    expect(row.className).toContain("touch-target")
    expect(screen.getByText("Configure a provider first")).toBeInTheDocument()
  })

  it("never renders the hint line on desktop (the tooltip carries it)", () => {
    render(<CapabilityRow icon={<i />} label="Web" hint="Configure a provider first" />)
    expect(screen.queryByText("Configure a provider first")).toBeNull()
  })

  it("is a toggle button with aria-pressed on desktop", () => {
    render(<CapabilityRow icon={<i />} label="Web" checkable active />)
    const row = screen.getByRole("button")
    expect(row).toHaveAttribute("aria-pressed", "true")
    expect(row).not.toHaveAttribute("aria-checked")
  })

  it("is a menuitemcheckbox with aria-checked in the mobile sheet", () => {
    platformMock.mockReturnValue("mobile")
    render(<CapabilityRow icon={<i />} label="Web" checkable active />)
    const row = screen.getByRole("menuitemcheckbox")
    expect(row).toHaveAttribute("aria-checked", "true")
    expect(row).not.toHaveAttribute("aria-pressed")
  })

  it("forwards aria / data attributes for trigger composition", () => {
    render(
      <CapabilityRow icon={<i />} label="Web" aria-label="Toggle web search" data-testid="row" />
    )
    const row = screen.getByTestId("row")
    expect(row).toHaveAttribute("aria-label", "Toggle web search")
  })

  it("disables like a normal button", () => {
    render(<CapabilityRow icon={<i />} label="Web" disabled />)
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("carries aria-disabled on a disabled mobile row like PlusRow", () => {
    platformMock.mockReturnValue("mobile")
    render(<CapabilityRow icon={<i />} label="Web" disabled />)
    const row = screen.getByRole("menuitem")
    expect(row).toBeDisabled()
    expect(row).toHaveAttribute("aria-disabled", "true")
  })

  it("does not set aria-disabled on desktop, matching PanelItem", () => {
    render(<CapabilityRow icon={<i />} label="Web" disabled />)
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-disabled")
  })

  it("draws the drill-down chevron only when asked", () => {
    const { rerender } = render(<CapabilityRow icon={<i />} label="Web" chevron />)
    expect(screen.getByRole("button").querySelector("svg.lucide-chevron-right")).not.toBeNull()
    rerender(<CapabilityRow icon={<i />} label="Web" />)
    expect(screen.getByRole("button").querySelector("svg.lucide-chevron-right")).toBeNull()
  })

  it("keeps the tooltip reachable on a disabled row via the span trigger", () => {
    render(
      <TooltipProvider>
        <CapabilityRow icon={<i />} label="Web" disabled tooltip="Configure a provider first" />
      </TooltipProvider>
    )
    const row = screen.getByRole("button")
    expect(row).toBeDisabled()
    // Disabled buttons swallow pointer events, so the trigger is the wrapper.
    expect(row.parentElement?.tagName).toBe("SPAN")
  })

  it("renders through the tooltip wrapper without losing the row", () => {
    render(
      <TooltipProvider>
        <CapabilityRow icon={<i />} label="Web" tooltip="Search with Tavily" />
      </TooltipProvider>
    )
    expect(screen.getByRole("button", { name: "Web" })).toBeInTheDocument()
  })
})
