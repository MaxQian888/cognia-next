import { probeConfiguredBootCapabilities } from "./startup-probe"

it("requests runtimes only for configured background work", async () => {
  const capabilities = await probeConfiguredBootCapabilities({
    getDatabase: () =>
      ({
        plugins: {
          toArray: async () => [
            {
              enabled: true,
              source: "marketplace",
              manifest: { activationEvents: ["startup"] },
            },
            {
              enabled: true,
              source: "builtin",
              manifest: { activationEvents: ["startup"] },
            },
          ],
        },
        adapterInstances: { toArray: async () => [{ enabled: true }] },
        memoryJobs: { toArray: async () => [{ status: "queued" }] },
        twinJobs: { toArray: async () => [] },
        chatGoals: { filter: () => ({ count: async () => 0 }) },
      }) as never,
    listScheduledTasks: async () => [{ status: "active" }],
    getTwinRuntimeSettings: async () => ({ workerEnabled: false }),
  })

  expect(capabilities).toEqual([
    "plugin-runtime",
    "workflow-automation",
    "integrations",
    "knowledge-agents",
  ])
})

it("keeps main startup light when no optional background work is configured", async () => {
  const capabilities = await probeConfiguredBootCapabilities({
    getDatabase: () =>
      ({
        plugins: { toArray: async () => [] },
        adapterInstances: { toArray: async () => [{ enabled: false }] },
        memoryJobs: { toArray: async () => [{ status: "completed" }] },
        twinJobs: { toArray: async () => [] },
        chatGoals: { filter: () => ({ count: async () => 0 }) },
      }) as never,
    listScheduledTasks: async () => [{ status: "paused" }],
    getTwinRuntimeSettings: async () => ({ workerEnabled: false }),
  })

  expect(capabilities).toEqual([])
})

it.each(["queued", "running"])(
  "boots knowledge agents for %s Twin work even when the worker setting is disabled",
  async (status) => {
    const capabilities = await probeConfiguredBootCapabilities({
      getDatabase: () =>
        ({
          plugins: { toArray: async () => [] },
          adapterInstances: { toArray: async () => [] },
          memoryJobs: { toArray: async () => [] },
          twinJobs: { toArray: async () => [{ status }] },
          chatGoals: { filter: () => ({ count: async () => 0 }) },
        }) as never,
      listScheduledTasks: async () => [],
      getTwinRuntimeSettings: async () => ({ workerEnabled: false }),
    })

    expect(capabilities).toEqual(["knowledge-agents"])
  }
)

it("boots knowledge agents for an enabled Twin worker without queued jobs", async () => {
  const capabilities = await probeConfiguredBootCapabilities({
    getDatabase: () =>
      ({
        plugins: { toArray: async () => [] },
        adapterInstances: { toArray: async () => [] },
        memoryJobs: { toArray: async () => [] },
        twinJobs: { toArray: async () => [] },
        chatGoals: { filter: () => ({ count: async () => 0 }) },
      }) as never,
    listScheduledTasks: async () => [],
    getTwinRuntimeSettings: async () => ({ workerEnabled: true }),
  })

  expect(capabilities).toEqual(["knowledge-agents"])
})

it("boots workflow automation to reconcile an admitted Goal verifier", async () => {
  const capabilities = await probeConfiguredBootCapabilities({
    getDatabase: () =>
      ({
        plugins: { toArray: async () => [] },
        adapterInstances: { toArray: async () => [] },
        memoryJobs: { toArray: async () => [] },
        twinJobs: { toArray: async () => [] },
        chatGoals: { filter: () => ({ count: async () => 1 }) },
      }) as never,
    listScheduledTasks: async () => [],
    getTwinRuntimeSettings: async () => ({ workerEnabled: false }),
  })

  expect(capabilities).toEqual(["workflow-automation"])
})
