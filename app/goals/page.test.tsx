import { render, screen } from "@testing-library/react"

let searchParams = new URLSearchParams()
const mockPush = jest.fn()
const mockReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}))

// Width decides desktop console vs phone body.
let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: () => compact }))

const consoleProps = jest.fn()
jest.mock("@/components/goal/console/goal-console", () => ({
  GoalConsole: (props: unknown) => {
    consoleProps(props)
    return <div data-testid="goal-console" />
  },
}))
jest.mock("@/components/mobile/goals/goals-mobile-body", () => ({
  GoalsMobileBody: () => <div data-testid="mobile-goals-body" />,
}))

import type { GoalConsoleProps } from "@/components/goal/console/goal-console"
import GoalsPage from "./page"

function lastProps(): GoalConsoleProps {
  return consoleProps.mock.calls.at(-1)![0] as GoalConsoleProps
}

beforeEach(() => {
  consoleProps.mockClear()
  mockPush.mockClear()
  mockReplace.mockClear()
  searchParams = new URLSearchParams()
  compact = false
})

describe("GoalsPage", () => {
  it("hosts the goal console with no location or selection by default", () => {
    render(<GoalsPage />)
    expect(screen.getByTestId("goal-console")).toBeInTheDocument()
    expect(lastProps()).toEqual(expect.objectContaining({ location: null, selectedGoalId: null }))
    expect(typeof lastProps().onNavigate).toBe("function")
  })

  it("renders the phone body instead on a compact layout", () => {
    compact = true
    render(<GoalsPage />)
    expect(screen.getByTestId("mobile-goals-body")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-console")).not.toBeInTheDocument()
  })

  it("passes a valid ?tab= through and drops an unknown one", () => {
    searchParams = new URLSearchParams("tab=analytics")
    render(<GoalsPage />)
    expect(lastProps().location).toEqual({ tab: "analytics" })

    searchParams = new URLSearchParams("tab=not-a-tab")
    render(<GoalsPage />)
    expect(lastProps().location).toBeNull()
  })

  it("lands a retired ?tab= on the matching Configure panel", () => {
    searchParams = new URLSearchParams("tab=defaults")
    render(<GoalsPage />)
    expect(lastProps().location).toEqual({ tab: "config", section: "defaults" })

    searchParams = new URLSearchParams("tab=templates")
    render(<GoalsPage />)
    expect(lastProps().location).toEqual({ tab: "config", section: "templates" })
  })

  it("reads ?section= on Configure only", () => {
    searchParams = new URLSearchParams("tab=config&section=tracker")
    render(<GoalsPage />)
    expect(lastProps().location).toEqual({ tab: "config", section: "tracker" })

    searchParams = new URLSearchParams("tab=history&section=tracker")
    render(<GoalsPage />)
    expect(lastProps().location).toEqual({ tab: "history" })
  })

  it("passes ?goal= as the selected goal", () => {
    searchParams = new URLSearchParams("tab=history&goal=goal_7")
    render(<GoalsPage />)
    expect(lastProps().selectedGoalId).toBe("goal_7")
  })

  it("pushes a navigation to the address, without scrolling", () => {
    render(<GoalsPage />)
    lastProps().onNavigate({ tab: "history", goalId: "goal_7" })
    expect(mockPush).toHaveBeenCalledWith("/goals?tab=history&goal=goal_7", { scroll: false })
    expect(mockReplace).not.toHaveBeenCalled()

    lastProps().onNavigate({ tab: "config", section: "templates" })
    expect(mockPush).toHaveBeenLastCalledWith("/goals?tab=config&section=templates", {
      scroll: false,
    })
  })

  it("replaces the address for a selection move", () => {
    render(<GoalsPage />)
    lastProps().onNavigate({ tab: "overview", goalId: "goal_2" }, { replace: true })
    expect(mockReplace).toHaveBeenCalledWith("/goals?tab=overview&goal=goal_2", {
      scroll: false,
    })
    expect(mockPush).not.toHaveBeenCalled()
  })
})
