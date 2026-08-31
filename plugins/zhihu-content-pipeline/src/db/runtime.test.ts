import {
  setPipelineDbFromDexie,
  getPipelineDb,
  __setPipelineDbForTesting,
  getPluginSession,
  setPluginSession,
} from "./runtime"
import type { PluginDexieAPI, PluginSessionAPI } from "@cognia/plugin-sdk"
const fakeDexie: PluginDexieAPI = {
  table: jest.fn() as unknown as PluginDexieAPI["table"],
  rawDb: jest.fn(),
}

afterEach(() => {
  __setPipelineDbForTesting(null)
  setPluginSession(null)
})

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

  it("publishes and clears the activated session API", () => {
    const session = { startSeededSession: jest.fn() } as unknown as PluginSessionAPI
    setPluginSession(session)
    expect(getPluginSession()).toBe(session)
    setPluginSession(null)
    expect(getPluginSession()).toBeNull()
  })
})
