import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { listCases } from "@/lib/db/eval-datasets"
import { ensureEvalStarterDataset, EVAL_STARTER_DATASET_ID } from "./starter-template"

describe("evaluation starter template", () => {
  const dbFixture = createDbTestFixture()

  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().evalDatasets.clear()
    await getDb().evalCases.clear()
  }, 30_000)

  afterAll(dbFixture.dispose)

  it("creates thirty reproducible holdout cases once and remains idempotent", async () => {
    const first = await ensureEvalStarterDataset({ name: "Starter", description: "Template" })
    const second = await ensureEvalStarterDataset({ name: "Changed", description: "Changed" })
    const cases = await listCases(EVAL_STARTER_DATASET_ID)

    expect(first.id).toBe(EVAL_STARTER_DATASET_ID)
    expect(second.id).toBe(first.id)
    expect(cases).toHaveLength(30)
    expect(cases.every((item) => item.split === "test")).toBe(true)
    expect(cases.every((item) => item.reference?.grading)).toBe(true)
    expect(cases[0]).toMatchObject({ source: "synthetic", metadata: { templateVersion: 1 } })
  })
})
