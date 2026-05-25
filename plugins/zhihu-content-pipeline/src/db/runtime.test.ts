import { setPipelineDbFromDexie, getPipelineDb, __setPipelineDbForTesting } from "./runtime"
import type { PluginDexieAPI } from "@/types/plugin"

const fakeDexie: PluginDexieAPI = {
  table: jest.fn() as unknown as PluginDexieAPI["table"],
  rawDb: jest.fn(),
}

afterEach(() => __setPipelineDbForTesting(null))

describe("pipeline db runtime singleton", () => {
  it("publishes a DB from a dexie handle and clears it on null", () => {
    expect(getPipelineDb()).toBeNull()
    setPipelineDbFromDexie(fakeDexie)
    expect(getPipelineDb()).not.toBeNull()
    setPipelineDbFromDexie(null)
    expect(getPipelineDb()).toBeNull()
  })

  it("treats undefined dexie as no DB", () => {
    setPipelineDbFromDexie(undefined)
    expect(getPipelineDb()).toBeNull()
  })

  it("supports test injection", () => {
    const fake = { listTopics: jest.fn() } as never
    __setPipelineDbForTesting(fake)
    expect(getPipelineDb()).toBe(fake)
  })
})
