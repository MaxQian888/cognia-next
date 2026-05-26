import "fake-indexeddb/auto"
import { render, screen } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import GoalsPage from "./page"

// next-intl globally mocked in jest.setup.ts.

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("GoalsPage", () => {
  it("hosts the goal console", async () => {
    render(<GoalsPage />)
    expect(await screen.findByTestId("goal-console")).toBeInTheDocument()
  })
})
