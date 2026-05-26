import "fake-indexeddb/auto"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { GoalsSection } from "./goals-section"

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector?: (s: unknown) => unknown) => {
    const state = { settings: null, save: jest.fn() }
    return selector ? selector(state) : state
  }),
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  routerPush.mockClear()
})

describe("GoalsSection (launcher)", () => {
  it("renders the header and a button into the goals console", () => {
    render(<GoalsSection />)
    expect(screen.getByTestId("goals-section")).toBeInTheDocument()
    expect(screen.getByTestId("goals-open-console")).toBeInTheDocument()
  })

  it("navigates to /goals when the launcher button is clicked", async () => {
    const user = userEvent.setup()
    render(<GoalsSection />)
    await user.click(screen.getByTestId("goals-open-console"))
    expect(routerPush).toHaveBeenCalledWith("/goals")
  })

  it("still shows the built-in Goal Tracker inline", async () => {
    render(<GoalsSection />)
    expect(await screen.findByTestId("goal-tracker-card")).toBeInTheDocument()
  })
})
