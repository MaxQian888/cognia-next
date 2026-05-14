import "fake-indexeddb/auto"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { GoalsSection } from "./goals-section"

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
})

describe("GoalsSection", () => {
  it("renders the page header and all three sub-tabs", () => {
    render(<GoalsSection />)
    expect(screen.getByTestId("goals-section")).toBeInTheDocument()
    expect(screen.getByText("Goals")).toBeInTheDocument()
    expect(screen.getByTestId("goals-section-history")).toBeInTheDocument()
    expect(screen.getByTestId("goals-section-tracker")).toBeInTheDocument()
    expect(screen.getByTestId("goals-section-defaults")).toBeInTheDocument()
  })

  it("switches tabs when the user clicks them", async () => {
    const user = userEvent.setup()
    render(<GoalsSection />)
    await user.click(screen.getByTestId("goals-section-tracker"))
    expect(screen.getByTestId("goals-section-tracker")).toHaveAttribute("data-state", "active")
  })
})
