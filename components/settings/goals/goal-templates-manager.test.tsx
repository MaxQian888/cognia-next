import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listGoalTemplates, upsertGoalTemplate } from "@/lib/db/goal-templates"
import type { GoalTemplate } from "@/types/goal"
import { GoalTemplatesManager } from "./goal-templates-manager"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json).

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().goalTemplates.clear()
})

function tpl(over: Partial<GoalTemplate> = {}): GoalTemplate {
  const now = Date.now()
  return {
    id: "t1",
    title: "Existing",
    objectiveText: "do the thing",
    builtin: false,
    isFavorite: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

describe("GoalTemplatesManager", () => {
  it("shows the empty state when there are no templates", async () => {
    render(<GoalTemplatesManager />)
    expect(await screen.findByTestId("goal-templates-empty")).toBeInTheDocument()
  })

  it("renders a row per template", async () => {
    await upsertGoalTemplate(tpl({ id: "a", title: "Alpha" }))
    await upsertGoalTemplate(tpl({ id: "b", title: "Beta" }))
    render(<GoalTemplatesManager />)
    await waitFor(() => expect(screen.getAllByTestId("goal-template-row")).toHaveLength(2))
  })

  it("creates a new template through the inline editor", async () => {
    render(<GoalTemplatesManager />)
    fireEvent.click(screen.getByTestId("goal-template-new"))
    fireEvent.change(screen.getByTestId("goal-template-title"), { target: { value: "Weekly" } })
    fireEvent.change(screen.getByTestId("goal-template-objective"), {
      target: { value: "summarise my week" },
    })
    fireEvent.click(screen.getByTestId("goal-template-save"))
    await waitFor(async () => {
      const rows = await listGoalTemplates()
      expect(rows.some((r) => r.title === "Weekly" && !r.builtin)).toBe(true)
    })
  })

  it("clones (does not mutate) a built-in when edited", async () => {
    await upsertGoalTemplate(tpl({ id: "builtin1", title: "Builtin", builtin: true }))
    render(<GoalTemplatesManager />)
    fireEvent.click(await screen.findByTestId("goal-template-edit"))
    fireEvent.change(screen.getByTestId("goal-template-title"), { target: { value: "My copy" } })
    fireEvent.click(screen.getByTestId("goal-template-save"))
    await waitFor(async () => {
      const rows = await listGoalTemplates()
      // Original built-in preserved + a new non-builtin clone exists.
      expect(rows.find((r) => r.id === "builtin1")?.title).toBe("Builtin")
      expect(rows.some((r) => r.title === "My copy" && !r.builtin)).toBe(true)
    })
  })

  it("toggles favourite", async () => {
    await upsertGoalTemplate(tpl({ id: "a", title: "Alpha" }))
    render(<GoalTemplatesManager />)
    fireEvent.click(await screen.findByTestId("goal-template-favorite"))
    await waitFor(async () => {
      const rows = await listGoalTemplates()
      expect(rows.find((r) => r.id === "a")?.isFavorite).toBe(true)
    })
  })

  it("deletes a non-built-in template", async () => {
    await upsertGoalTemplate(tpl({ id: "a", title: "Alpha" }))
    render(<GoalTemplatesManager />)
    fireEvent.click(await screen.findByTestId("goal-template-delete"))
    await waitFor(async () => {
      const rows = await listGoalTemplates()
      expect(rows.find((r) => r.id === "a")).toBeUndefined()
    })
  })
})
