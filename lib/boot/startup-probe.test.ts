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
      }) as never,
    listScheduledTasks: async () => [{ status: "active" }],
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
      }) as never,
    listScheduledTasks: async () => [{ status: "paused" }],
  })

  expect(capabilities).toEqual([])
})
