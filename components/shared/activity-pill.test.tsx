/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PauseIcon, SquareIcon, SearchIcon, TargetIcon } from "lucide-react"
import { ActivityPill, type ActivityPillAction } from "./activity-pill"

const useBreakpointMock = jest.fn().mockReturnValue("desktop")
jest.mock("@/hooks/ui/use-breakpoint", () => ({
  useBreakpoint: () => useBreakpointMock(),
}))

beforeEach(() => {
  useBreakpointMock.mockReset().mockReturnValue("desktop")
})

function buildActions(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const onPause = overrides.onPause ?? jest.fn()
  const onStop = overrides.onStop ?? jest.fn()
  const onDetails = overrides.onDetails ?? jest.fn()
  const actions: ActivityPillAction[] = [
    {
      id: "pause",
      icon: <PauseIcon />,
      label: "Pause",
      onClick: onPause,
      testId: "pill-pause",
      primary: true,
    },
    { id: "stop", icon: <SquareIcon />, label: "Stop", onClick: onStop, testId: "pill-stop" },
    {
      id: "details",
      icon: <SearchIcon />,
      label: "Details",
      onClick: onDetails,
      testId: "pill-details",
    },
  ]
  return { actions, onPause, onStop, onDetails }
}

function renderPill(actions: ActivityPillAction[], footnote?: string) {
  return render(
    <ActivityPill
      icon={<TargetIcon />}
      title="Ship the feature"
      chip={{
        label: "Active",
        chipClassName: "bg-success/10",
        dotClassName: "bg-success",
        pulse: true,
      }}
      subtext="3/20 turns"
      footnote={footnote}
      actions={actions}
      ariaLabel="Active goal: Ship the feature"
      moreLabel="More actions"
      data-testid="test-pill"
    />
  )
}

describe("ActivityPill — desktop", () => {
  it("renders title, chip, subtext, and ALL actions inline", () => {
    const { actions } = buildActions()
    renderPill(actions)
    expect(screen.getByTestId("test-pill")).toHaveAttribute("role", "status")
    expect(screen.getByText("Ship the feature")).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("3/20 turns")).toBeInTheDocument()
    expect(screen.getByTestId("pill-pause")).toBeInTheDocument()
    expect(screen.getByTestId("pill-stop")).toBeInTheDocument()
    expect(screen.getByTestId("pill-details")).toBeInTheDocument()
    expect(screen.queryByTestId("activity-pill-more")).toBeNull()
  })

  it("fires the action callbacks from the inline buttons", async () => {
    const { actions, onPause, onStop } = buildActions()
    renderPill(actions)
    await userEvent.click(screen.getByTestId("pill-pause"))
    await userEvent.click(screen.getByTestId("pill-stop"))
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("renders the footnote line when provided", () => {
    const { actions } = buildActions()
    renderPill(actions, "next continuation at 14:30")
    expect(screen.getByTestId("activity-pill-footnote")).toHaveTextContent(
      "next continuation at 14:30"
    )
  })

  it("omits the footnote node when absent", () => {
    const { actions } = buildActions()
    renderPill(actions)
    expect(screen.queryByTestId("activity-pill-footnote")).toBeNull()
  })
})

describe("ActivityPill — mobile collapse", () => {
  beforeEach(() => useBreakpointMock.mockReturnValue("mobile"))

  it("keeps primary actions inline and collapses the rest behind the more menu", () => {
    const { actions } = buildActions()
    renderPill(actions)
    expect(screen.getByTestId("pill-pause")).toBeInTheDocument()
    expect(screen.queryByTestId("pill-stop")).toBeNull()
    expect(screen.queryByTestId("pill-details")).toBeNull()
    expect(screen.getByTestId("activity-pill-more")).toBeInTheDocument()
  })

  it("exposes collapsed actions as menu items with their original testids", async () => {
    const { actions, onStop } = buildActions()
    renderPill(actions)
    await userEvent.click(screen.getByTestId("activity-pill-more"))
    const stopItem = await screen.findByTestId("pill-stop")
    expect(stopItem).toBeInTheDocument()
    await userEvent.click(stopItem)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("uses ≥44px touch targets on mobile", () => {
    const { actions } = buildActions()
    renderPill(actions)
    expect(screen.getByTestId("pill-pause").className).toContain("size-11")
    expect(screen.getByTestId("activity-pill-more").className).toContain("size-11")
  })

  it("renders no more-menu when every action is primary", () => {
    const actions: ActivityPillAction[] = [
      {
        id: "a",
        icon: <PauseIcon />,
        label: "A",
        onClick: jest.fn(),
        testId: "only-a",
        primary: true,
      },
    ]
    renderPill(actions)
    expect(screen.getByTestId("only-a")).toBeInTheDocument()
    expect(screen.queryByTestId("activity-pill-more")).toBeNull()
  })

  it("tablet renders all actions inline like desktop", () => {
    useBreakpointMock.mockReturnValue("tablet")
    const { actions } = buildActions()
    renderPill(actions)
    expect(screen.getByTestId("pill-stop")).toBeInTheDocument()
    expect(screen.queryByTestId("activity-pill-more")).toBeNull()
    expect(screen.getByTestId("pill-stop").className).toContain("size-7")
  })
})
