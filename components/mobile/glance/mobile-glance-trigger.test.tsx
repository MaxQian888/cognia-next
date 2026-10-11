/**
 * @jest-environment jsdom
 */

import { render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("./mobile-glance-provider", () => ({ useMobileGlanceContext: jest.fn() }))
jest.mock("@/hooks/fleet/use-fleet-snapshot", () => ({ useFleetSnapshot: jest.fn() }))

import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu"
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"
import type { FleetSession } from "@/lib/fleet/types"
import type { GlanceFleetSlice } from "@/lib/glance/snapshot"

import { useMobileGlanceContext } from "./mobile-glance-provider"
import { MobileGlanceFoldedDot, MobileGlanceTrigger, useGlanceAttention } from "./mobile-glance-trigger"

const useContextMock = useMobileGlanceContext as jest.Mock
const useFleetSnapshotMock = useFleetSnapshot as jest.Mock
const setDrawerOpen = jest.fn<void, [boolean]>()

function fleetSlice(awaiting: number, failed: number): GlanceFleetSlice {
  return {
    updatedAt: 1,
    counts: { working: 0, awaiting, failed },
    total: 0,
    rows: [],
    workflows: { running: 0, latest: null },
  }
}

/** Arrange the two sources the dot reads: the Fleet mirror and the glance fleet slice. */
function arrange({
  mirror = [],
  slice = null,
}: {
  mirror?: FleetSession["status"][]
  slice?: GlanceFleetSlice | null
}) {
  useFleetSnapshotMock.mockReturnValue({
    snapshot: {
      sessions: mirror.map((status, i) => ({ id: `s${i}`, status }) as unknown as FleetSession),
      generatedAt: 0,
    },
    source: "companion",
  })
  useContextMock.mockReturnValue({ glance: { snapshot: { fleet: slice } }, setDrawerOpen })
}

beforeEach(() => {
  setDrawerOpen.mockReset()
  arrange({})
})

describe("useGlanceAttention", () => {
  const attention = () => renderHook(() => useGlanceAttention()).result.current

  it("is null with nothing waiting or failed", () => {
    arrange({ mirror: ["working", "idle"], slice: fleetSlice(0, 0) })
    expect(attention()).toBeNull()
  })

  it("is null without a glance fleet slice and an empty mirror", () => {
    arrange({ mirror: [], slice: null })
    expect(attention()).toBeNull()
  })

  it.each<FleetSession["status"]>(["waiting-permission", "plan-pending", "waiting-input"])(
    "warns when the Fleet mirror has a session that is %s",
    (status) => {
      arrange({ mirror: ["working", status], slice: null })
      expect(attention()).toBe("warn")
    }
  )

  it("warns when the glance fleet slice has something awaiting", () => {
    arrange({ mirror: ["working"], slice: fleetSlice(1, 0) })
    expect(attention()).toBe("warn")
  })

  it("prefers waiting over failed: it is the one a person can unblock", () => {
    arrange({ mirror: ["waiting-input"], slice: fleetSlice(0, 2) })
    expect(attention()).toBe("warn")
    arrange({ mirror: [], slice: fleetSlice(1, 2) })
    expect(attention()).toBe("warn")
  })

  it("errors when only something failed", () => {
    arrange({ mirror: ["working", "ended"], slice: fleetSlice(0, 1) })
    expect(attention()).toBe("error")
  })
})

describe("MobileGlanceTrigger (icon)", () => {
  it("opens the drawer and is named plainly without attention", async () => {
    const user = userEvent.setup()
    render(<MobileGlanceTrigger className="extra" />)
    const button = screen.getByRole("button", { name: "Open Glance" })
    expect(button).toHaveAttribute("data-testid", "mobile-glance-trigger")
    expect(button).toHaveClass("touch-target", "extra")
    expect(screen.queryByTestId("mobile-glance-attention")).not.toBeInTheDocument()
    await user.click(button)
    expect(setDrawerOpen).toHaveBeenCalledWith(true)
  })

  it("says something needs attention and shows a warn dot", () => {
    arrange({ mirror: ["waiting-permission"] })
    render(<MobileGlanceTrigger />)
    const button = screen.getByRole("button", {
      name: "Open Glance — something needs your attention",
    })
    const dot = screen.getByTestId("mobile-glance-attention")
    expect(button).toContainElement(dot)
    expect(dot).toHaveAttribute("data-attention", "warn")
    expect(dot).toHaveAttribute("aria-hidden", "true")
    expect(dot).toHaveClass("bg-warning")
  })

  it("shows an error dot for a failure", () => {
    arrange({ slice: fleetSlice(0, 1) })
    render(<MobileGlanceTrigger />)
    expect(screen.getByTestId("mobile-glance-attention")).toHaveAttribute("data-attention", "error")
    expect(screen.getByTestId("mobile-glance-attention")).toHaveClass("bg-destructive")
    expect(
      screen.getByRole("button", { name: "Open Glance — something needs your attention" })
    ).toBeInTheDocument()
  })
})

describe("MobileGlanceTrigger (menu)", () => {
  function renderInMenu() {
    return render(
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <MobileGlanceTrigger variant="menu" />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  it("is a menu row that opens the drawer once the menu has closed", async () => {
    const user = userEvent.setup()
    renderInMenu()
    const item = await screen.findByRole("menuitem", { name: "Glance" })
    expect(item).toHaveAttribute("data-testid", "mobile-action-glance")
    expect(screen.queryByTestId("mobile-glance-attention")).not.toBeInTheDocument()
    await user.click(item)
    await waitFor(() => expect(setDrawerOpen).toHaveBeenCalledWith(true))
  })

  it("keeps the attention dot on the row", async () => {
    arrange({ slice: fleetSlice(2, 0) })
    renderInMenu()
    const item = await screen.findByRole("menuitem", { name: "Glance" })
    const dot = screen.getByTestId("mobile-glance-attention")
    expect(item).toContainElement(dot)
    expect(dot).toHaveAttribute("data-attention", "warn")
  })
})

describe("MobileGlanceFoldedDot", () => {
  it("renders nothing without attention", () => {
    const { container } = render(<MobileGlanceFoldedDot className="absolute" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the dot, with the caller's placement, when something needs attention", () => {
    arrange({ slice: fleetSlice(0, 3) })
    render(<MobileGlanceFoldedDot className="absolute right-1 top-1" />)
    const dot = screen.getByTestId("mobile-glance-attention")
    expect(dot).toHaveAttribute("data-attention", "error")
    expect(dot).toHaveClass("absolute", "right-1", "top-1")
  })
})
