import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { seedBuiltInCharacters } from "@/lib/db/characters"
import { GoalTrackerConfig } from "./goal-tracker-config"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("GoalTrackerConfig", () => {
  it("renders the card once the Goal Tracker character is seeded", async () => {
    await seedBuiltInCharacters()
    render(<GoalTrackerConfig />)
    await waitFor(() => expect(screen.getByTestId("goal-tracker-card")).toBeInTheDocument())
    expect(screen.getByText("Goal Tracker")).toBeInTheDocument()
    // "outcome-driven agent" appears in both the description and the
    // systemPrompt — getAllByText is safer than getByText here.
    expect(screen.getAllByText(/outcome-driven agent/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/Permission mode: acceptEdits/)).toBeInTheDocument()
  })

  it("shows the missing-state when the character isn't seeded", async () => {
    // Don't seed the built-ins → render should show the missing badge
    await getDb().characters.clear()
    render(<GoalTrackerConfig />)
    await waitFor(() => expect(screen.getByTestId("goal-tracker-missing")).toBeInTheDocument())
  })
})
