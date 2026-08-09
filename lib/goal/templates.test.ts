import { createDbTestFixture } from "@/lib/db/test-fixture"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import type { GoalTemplate } from "@/types/goal"
import { upsertGoalTemplate } from "@/lib/db/goal-templates"
import { __resetGoalRuntimeForTesting } from "./runtime"
import { createGoalFromTemplate, GoalTemplateNotFound } from "./templates"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
})

function tpl(over: Partial<GoalTemplate> = {}): GoalTemplate {
  const now = Date.now()
  return {
    id: "t1",
    title: "Review",
    objectiveText: "review the PR",
    configOverrides: { maxTurns: 30 },
    builtin: false,
    isFavorite: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

afterAll(dbFixture.dispose)

describe("createGoalFromTemplate", () => {
  it("creates an active goal from the template objective + config overrides", async () => {
    await upsertGoalTemplate(tpl({ id: "t1" }))
    const goal = await createGoalFromTemplate({ templateId: "t1", sessionId: "ses_x" })
    expect(goal.rawObjective).toBe("review the PR")
    expect(goal.config.maxTurns).toBe(30)
    expect(goal.status).toBe("active")
    expect(goal.sessionId).toBe("ses_x")
  })

  it("throws GoalTemplateNotFound for an unknown id", async () => {
    await expect(
      createGoalFromTemplate({ templateId: "ghost", sessionId: "ses_x" })
    ).rejects.toBeInstanceOf(GoalTemplateNotFound)
  })
})
