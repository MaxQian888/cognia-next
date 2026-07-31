import {
  applyEvalRecommendation,
  previewConfigurationDiff,
  rollbackEvalRecommendation,
  type EvalConfigurationTarget,
} from "./recommendation-application"

describe("recommendation application", () => {
  const target: EvalConfigurationTarget = {
    targetType: "default-model",
    targetId: "global",
  }

  it("shows a stable field-level diff before explicit application", () => {
    expect(
      previewConfigurationDiff(
        { providerId: "old", modelId: "old-model", temperature: 0.2 },
        { providerId: "new", modelId: "new-model", temperature: 0.2 }
      )
    ).toEqual([
      { path: "modelId", before: "old-model", after: "new-model" },
      { path: "providerId", before: "old", after: "new" },
    ])
  })

  it("stores the previous configuration and rolls back exactly once", async () => {
    let current: Record<string, unknown> = { providerId: "old", modelId: "old-model" }
    const records = new Map<string, Record<string, unknown>>()
    const deps = {
      read: jest.fn(async () => current),
      write: jest.fn(async (_target: EvalConfigurationTarget, value: Record<string, unknown>) => {
        current = value
      }),
      saveRecord: jest.fn(
        async (record: { id: string }) => void records.set(record.id, record as never)
      ),
      getRecord: jest.fn(async (id: string) => records.get(id) as never),
      updateRecord: jest.fn(async (id: string, patch: Record<string, unknown>) => {
        Object.assign(records.get(id)!, patch)
      }),
      now: () => 100,
      newId: () => "apply-1",
    }

    const application = await applyEvalRecommendation(
      "experiment-1",
      target,
      { providerId: "new", modelId: "new-model" },
      deps
    )
    expect(current).toEqual({ providerId: "new", modelId: "new-model" })
    expect(application.previousConfiguration).toEqual({ providerId: "old", modelId: "old-model" })

    await rollbackEvalRecommendation(application.id, deps)
    expect(current).toEqual({ providerId: "old", modelId: "old-model" })
    await expect(rollbackEvalRecommendation(application.id, deps)).rejects.toThrow(/already/i)
  })

  it("refuses rollback when the target changed after application", async () => {
    const record = {
      id: "apply-1",
      experimentId: "experiment-1",
      ...target,
      previousConfiguration: { modelId: "old" },
      appliedConfiguration: { modelId: "recommended" },
      appliedAt: 1,
    }
    const deps = {
      read: async () => ({ modelId: "manually-changed" }),
      write: jest.fn(),
      saveRecord: jest.fn(),
      getRecord: async () => record,
      updateRecord: jest.fn(),
      now: () => 2,
      newId: () => "unused",
    }

    await expect(rollbackEvalRecommendation(record.id, deps)).rejects.toThrow(/changed/i)
    expect(deps.write).not.toHaveBeenCalled()
  })
})
