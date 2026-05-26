import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { BUILTIN_GOAL_TEMPLATES, seedGoalTemplates } from "./seed-templates"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded() // runs seedBuiltIns → seedGoalTemplates
})

describe("seedGoalTemplates", () => {
  it("seeds all built-in templates on first run (via whenSeeded)", async () => {
    const rows = await getDb().goalTemplates.toArray()
    const builtins = rows.filter((r) => r.builtin)
    expect(builtins).toHaveLength(BUILTIN_GOAL_TEMPLATES.length)
    expect(builtins.every((r) => r.builtin && !r.isFavorite)).toBe(true)
  })

  it("is idempotent — re-running adds no duplicates", async () => {
    await seedGoalTemplates()
    await seedGoalTemplates()
    const builtins = (await getDb().goalTemplates.toArray()).filter((r) => r.builtin)
    expect(builtins).toHaveLength(BUILTIN_GOAL_TEMPLATES.length)
  })

  it("does not clobber an edit to an existing built-in id", async () => {
    const id = BUILTIN_GOAL_TEMPLATES[0]!.id
    const existing = (await getDb().goalTemplates.get(id))!
    await getDb().goalTemplates.put({ ...existing, title: "EDITED BY USER" })
    await seedGoalTemplates()
    expect((await getDb().goalTemplates.get(id))?.title).toBe("EDITED BY USER")
  })
})
