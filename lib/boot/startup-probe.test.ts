import {
  createOperationPerformanceRecorder,
  getOperationPerformanceRecorder,
} from "@/lib/perf/operation-performance"
import { probeConfiguredBootCapabilities } from "./startup-probe"

it("requests runtimes only for configured background work", async () => {
  const recorder = enableOperationRecording()
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

  expect(
    recorder.getSnapshot().rows.find((row) => row.name === "startup.capability-probe")
  ).toMatchObject({ count: 1, errors: 0 })
  expect(capabilities).toEqual([
    "plugin-runtime",
    "workflow-automation",
    "integrations",
    "knowledge-agents",
  ])
})

it("requests plugin-runtime for a user-enabled built-in startup plugin", async () => {
  const capabilities = await probeConfiguredBootCapabilities({
    getDatabase: () =>
      ({
        plugins: {
          toArray: async () => [
            {
              enabled: true,
              source: "builtin",
              manifest: { activationEvents: ["startup"] },
            },
          ],
        },
        adapterInstances: { toArray: async () => [] },
        memoryJobs: { toArray: async () => [] },
        twinJobs: { toArray: async () => [] },
        chatGoals: { filter: () => ({ count: async () => 0 }) },
      }) as never,
    listScheduledTasks: async () => [],
    getTwinRuntimeSettings: async () => ({ workerEnabled: false }),
  })

  expect(capabilities).toEqual(["plugin-runtime"])
})

it.each([
  ["a disabled built-in startup plugin", { enabled: false, source: "builtin" }],
  [
    "an enabled built-in without startup activation",
    {
      enabled: true,
      source: "builtin",
      manifest: { activationEvents: ["onView:chat.input.menu"] },
    },
  ],
])("requests no runtime for %s", async (_label, plugin) => {
  const capabilities = await probeConfiguredBootCapabilities({
    getDatabase: () =>
      ({
        plugins: {
          toArray: async () => [{ manifest: { activationEvents: ["startup"] }, ...plugin }],
        },
        adapterInstances: { toArray: async () => [] },
        memoryJobs: { toArray: async () => [] },
        twinJobs: { toArray: async () => [] },
        chatGoals: { filter: () => ({ count: async () => 0 }) },
      }) as never,
    listScheduledTasks: async () => [],
    getTwinRuntimeSettings: async () => ({ workerEnabled: false }),
  })

  expect(capabilities).toEqual([])
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

it("records the complete capability probe without storing its result or failure details", async () => {
  const recorder = enableOperationRecording()
  const failure = new Error("private database details")
  try {
    await expect(
      probeConfiguredBootCapabilities({
        getDatabase: () => {
          throw failure
        },
        listScheduledTasks: async () => [],
        getTwinRuntimeSettings: async () => ({}),
      })
    ).rejects.toBe(failure)
    expect(
      recorder.getSnapshot().rows.find((row) => row.name === "startup.capability-probe")
    ).toMatchObject({ count: 1, errors: 1 })
    expect(JSON.stringify(recorder.getSnapshot())).not.toContain(failure.message)
  } finally {
    recorder.updateSettings({ enabled: false })
    recorder.clear()
  }
})

// Use the actual recorder/helper with a browser-capable memory store while
// keeping Dexie tests in their native Node environment.
let operationRecordingSpy: jest.SpyInstance | undefined
function enableOperationRecording() {
  const storage = new Map<string, string>()
  const recorder = createOperationPerformanceRecorder({
    isBrowser: () => true,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value)
      },
    },
  })
  recorder.updateSettings({ enabled: true })
  operationRecordingSpy = jest
    .spyOn(getOperationPerformanceRecorder(), "begin")
    .mockImplementation(recorder.begin)
  return recorder
}
afterEach(() => {
  operationRecordingSpy?.mockRestore()
  operationRecordingSpy = undefined
})
