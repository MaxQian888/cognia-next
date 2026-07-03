import { render, screen } from "@testing-library/react"

let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}))

// Desktop platform so the page renders the console (not the mobile body).
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "web" }))

const consoleProps = jest.fn()
jest.mock("@/components/goal/console/goal-console", () => ({
  GoalConsole: (props: unknown) => {
    consoleProps(props)
    return <div data-testid="goal-console" />
  },
}))

import GoalsPage from "./page"

beforeEach(() => {
  consoleProps.mockClear()
  searchParams = new URLSearchParams()
})

describe("GoalsPage", () => {
  it("hosts the goal console with no initial tab by default", () => {
    render(<GoalsPage />)
    expect(screen.getByTestId("goal-console")).toBeInTheDocument()
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ initialTab: undefined }))
  })

  it("passes a valid ?tab= deep link through and drops an invalid one", () => {
    searchParams = new URLSearchParams("tab=defaults")
    render(<GoalsPage />)
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ initialTab: "defaults" }))

    consoleProps.mockClear()
    searchParams = new URLSearchParams("tab=not-a-tab")
    render(<GoalsPage />)
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ initialTab: undefined }))
  })
})
