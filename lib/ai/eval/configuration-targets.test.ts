import type { EvalConfigurationTarget } from "./recommendation-application"
import { createEvalConfigurationApplicationDeps } from "./configuration-targets"

describe("evaluation recommendation configuration targets", () => {
  it("reads and writes every explicit supported target through its canonical store", async () => {
    const writes: Array<{ target: string; value: Record<string, unknown> }> = []
    const deps = createEvalConfigurationApplicationDeps({
      getSettings: async () =>
        ({
          defaultProvider: "old-provider",
          defaultModel: "old-model",
          routingConfig: { strategy: "balanced" },
        }) as never,
      saveSettings: async (patch) => {
        writes.push({ target: "settings", value: patch as Record<string, unknown> })
        return {} as never
      },
      getCharacter: async () => ({ id: "char", model: "old-model", systemPrompt: "old" }) as never,
      updateCharacter: async (_id, patch) =>
        void writes.push({ target: "character", value: patch as never }),
      getWorkflow: async () =>
        ({ id: "workflow", settings: { concurrency: 1 }, nodes: [], edges: [] }) as never,
      updateWorkflow: async (_id, patch) => {
        writes.push({ target: "workflow", value: patch as never })
        return {} as never
      },
      saveRecord: async () => {},
      getRecord: async () => undefined,
      updateRecord: async () => {},
      now: () => 1,
      newId: () => "apply",
    })

    const targets: Array<[EvalConfigurationTarget, Record<string, unknown>]> = [
      [
        { targetType: "default-model", targetId: "global" },
        { providerId: "p", modelId: "m" },
      ],
      [
        { targetType: "character", targetId: "char" },
        { model: "m", systemPrompt: "new" },
      ],
      [{ targetType: "workflow", targetId: "workflow" }, { settings: { concurrency: 2 } }],
      [{ targetType: "routing-policy", targetId: "global" }, { strategy: "quality" }],
    ]

    for (const [target, value] of targets) {
      expect(await deps.read(target)).toBeDefined()
      await deps.write(target, value)
    }
    expect(writes).toEqual([
      { target: "settings", value: { defaultProvider: "p", defaultModel: "m" } },
      { target: "character", value: { model: "m", systemPrompt: "new" } },
      { target: "workflow", value: { settings: { concurrency: 2 } } },
      { target: "settings", value: { routingConfig: { strategy: "quality" } } },
    ])
  })

  it("rejects missing targets and invalid default model payloads", async () => {
    const deps = createEvalConfigurationApplicationDeps({
      getSettings: async () => ({}) as never,
      saveSettings: async () => ({}) as never,
      getCharacter: async () => undefined,
      updateCharacter: async () => {},
      getWorkflow: async () => undefined,
      updateWorkflow: async () => undefined,
      saveRecord: async () => {},
      getRecord: async () => undefined,
      updateRecord: async () => {},
      now: () => 1,
      newId: () => "apply",
    })

    await expect(deps.read({ targetType: "character", targetId: "missing" })).rejects.toThrow(
      /not found/
    )
    await expect(
      deps.write({ targetType: "default-model", targetId: "global" }, { modelId: "m" })
    ).rejects.toThrow(/providerId/)
  })
})
