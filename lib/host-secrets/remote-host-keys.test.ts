import {
  clearRemoteHostKeyedProviders,
  isRemoteHostKeyedProvider,
  remoteHostKeyedProviders,
  remoteHostKeysHostId,
  resetRemoteHostKeysForTests,
  setRemoteHostKeyedProviders,
  subscribeRemoteHostKeyedProviders,
  withRemoteHostKeyedProviders,
} from "./remote-host-keys"

afterEach(() => resetRemoteHostKeysForTests())

describe("the driven Host's keyed providers", () => {
  it("holds ids for one Host and notifies only on a change", () => {
    const onChange = jest.fn()
    const stop = subscribeRemoteHostKeyedProviders(onChange)

    setRemoteHostKeyedProviders("host-1", ["deepseek", " ", "kimi"])
    expect([...remoteHostKeyedProviders()].sort()).toEqual(["deepseek", "kimi"])
    expect(isRemoteHostKeyedProvider("deepseek")).toBe(true)
    expect(remoteHostKeysHostId()).toBe("host-1")
    expect(onChange).toHaveBeenCalledTimes(1)

    setRemoteHostKeyedProviders("host-1", ["kimi", "deepseek"])
    expect(onChange).toHaveBeenCalledTimes(1)

    setRemoteHostKeyedProviders("host-2", ["kimi", "deepseek"])
    expect(onChange).toHaveBeenCalledTimes(2)

    clearRemoteHostKeyedProviders()
    clearRemoteHostKeyedProviders()
    expect(remoteHostKeyedProviders().size).toBe(0)
    expect(remoteHostKeysHostId()).toBeNull()
    expect(onChange).toHaveBeenCalledTimes(3)

    stop()
    setRemoteHostKeyedProviders("host-1", ["deepseek"])
    expect(onChange).toHaveBeenCalledTimes(3)
  })
})

describe("withRemoteHostKeyedProviders", () => {
  const keyed = new Set(["deepseek", "kimi", "openai"])

  it("adds or enables keyless providers the Host keys", () => {
    const providers = {
      kimi: { providerId: "kimi", enabled: false },
      openai: { providerId: "openai", enabled: false, apiKey: "own" },
    }
    const next = withRemoteHostKeyedProviders(providers, keyed)
    expect(next).toEqual({
      deepseek: { providerId: "deepseek", enabled: true },
      kimi: { providerId: "kimi", enabled: true },
      // A provider this device keys itself keeps its own switch.
      openai: { providerId: "openai", enabled: false, apiKey: "own" },
    })
    expect(providers.kimi.enabled).toBe(false)
  })

  it("returns the same object when there is nothing to add", () => {
    const providers = {
      deepseek: { providerId: "deepseek", enabled: true },
      kimi: { providerId: "kimi", apiKeys: ["rotated"] },
      openai: { providerId: "openai", apiKey: "own" },
    }
    expect(withRemoteHostKeyedProviders(providers, keyed)).toBe(providers)
    expect(withRemoteHostKeyedProviders(providers, new Set())).toBe(providers)
    expect(withRemoteHostKeyedProviders(undefined, new Set())).toBeUndefined()
  })

  it("reads the current Host's ids by default", () => {
    setRemoteHostKeyedProviders("host-1", ["deepseek"])
    expect(withRemoteHostKeyedProviders(undefined)).toEqual({
      deepseek: { providerId: "deepseek", enabled: true },
    })
  })
})
