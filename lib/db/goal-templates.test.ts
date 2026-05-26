import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { GoalTemplate } from "@/types/goal"
import {
  deleteGoalTemplate,
  getGoalTemplate,
  listGoalTemplates,
  setTemplateFavorite,
  upsertGoalTemplate,
} from "./goal-templates"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  // Isolate from the seeded built-ins so ordering assertions are deterministic.
  await getDb().goalTemplates.clear()
})

function tpl(over: Partial<GoalTemplate> = {}): GoalTemplate {
  const now = Date.now()
  return {
    id: "t1",
    title: "T1",
    objectiveText: "do x",
    builtin: false,
    isFavorite: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

describe("goal-templates CRUD (v53)", () => {
  it("upsert + get round-trips the row", async () => {
    await upsertGoalTemplate(tpl({ id: "a", configOverrides: { maxTurns: 9 } }))
    const got = await getGoalTemplate("a")
    expect(got?.title).toBe("T1")
    expect(got?.configOverrides?.maxTurns).toBe(9)
  })

  it("list sorts favourites first, then sortOrder, then title", async () => {
    await upsertGoalTemplate(tpl({ id: "a", title: "Apple", sortOrder: 2 }))
    await upsertGoalTemplate(tpl({ id: "b", title: "Banana", sortOrder: 1 }))
    await upsertGoalTemplate(tpl({ id: "c", title: "Cherry", isFavorite: true, sortOrder: 5 }))
    const list = await listGoalTemplates()
    expect(list.map((t) => t.id)).toEqual(["c", "b", "a"])
  })

  it("setTemplateFavorite toggles the flag", async () => {
    await upsertGoalTemplate(tpl({ id: "a" }))
    await setTemplateFavorite("a", true)
    expect((await getGoalTemplate("a"))?.isFavorite).toBe(true)
  })

  it("setTemplateFavorite is a no-op for a missing row", async () => {
    await setTemplateFavorite("ghost", true)
    expect(await getGoalTemplate("ghost")).toBeUndefined()
  })

  it("delete removes the row", async () => {
    await upsertGoalTemplate(tpl({ id: "a" }))
    await deleteGoalTemplate("a")
    expect(await getGoalTemplate("a")).toBeUndefined()
  })
})
