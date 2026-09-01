import { resolveTeamMemoryRuntime } from "./memory-context"

const getSettings = jest.fn(async () => ({ memory: { enabled: true } }))
const tryBuildMemoryDeps = jest.fn(async () => ({ loadCandidates: jest.fn() }))
const storeSettings = { memory: { enabled: true, source: "store" } }

jest.mock("@/lib/db/settings", () => ({
  getSettings: (...a: unknown[]) => getSettings(...(a as [])),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: storeSettings }) },
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: (...a: unknown[]) => tryBuildMemoryDeps(...(a as [])),
}))

describe("resolveTeamMemoryRuntime", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getSettings.mockResolvedValue({ memory: { enabled: true } })
    tryBuildMemoryDeps.mockResolvedValue({ loadCandidates: jest.fn() })
  })

  it("builds the read deps from persisted settings", async () => {
    const deps = await resolveTeamMemoryRuntime()
    expect(deps).toBeDefined()
    expect(tryBuildMemoryDeps).toHaveBeenCalledTimes(1)
    // `resolveMemoryConfig` fills the defaults, so the enabled flag survives.
    expect(tryBuildMemoryDeps.mock.calls[0]![0]).toMatchObject({ enabled: true })
  })

  it("shares the run's twin deps rather than opening a second vector client", async () => {
    const twinDeps = { marker: "twin" } as never
    await resolveTeamMemoryRuntime(twinDeps)
    expect(tryBuildMemoryDeps.mock.calls[0]![1]).toBe(twinDeps)
  })

  it("falls back to the settings store when Dexie is unreachable", async () => {
    getSettings.mockRejectedValue(new Error("no indexeddb"))
    await resolveTeamMemoryRuntime()
    expect(tryBuildMemoryDeps).toHaveBeenCalledTimes(1)
  })

  it("degrades to no recall instead of failing the run", async () => {
    // A memory misconfiguration must never take a Squad run down with it: the
    // surface had no recall at all before this helper existed.
    tryBuildMemoryDeps.mockRejectedValue(new Error("embedding backend down"))
    await expect(resolveTeamMemoryRuntime()).resolves.toBeUndefined()
  })

  it("returns nothing when memory is disabled", async () => {
    tryBuildMemoryDeps.mockResolvedValue(undefined as never)
    await expect(resolveTeamMemoryRuntime()).resolves.toBeUndefined()
  })
})
