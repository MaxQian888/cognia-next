import { createProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"

import {
  hostProviderKey,
  installHostProviderKeys,
  loadHostProviderKeys,
  replaceHostProviderKeys,
  type HostProviderKeyDeps,
} from "./provider-key-overlay"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => replaceHostProviderKeys([]))

function deps(answers: Array<Array<[string, string]> | Error>) {
  let onChange: (() => void) | null = null
  const unsubscribe = jest.fn()
  const log = jest.fn()
  const value: HostProviderKeyDeps = {
    load: jest.fn(async () => {
      const next = answers.shift()
      if (!next) return { keys: [] }
      if (next instanceof Error) throw next
      return { keys: next.map(([providerId, apiKey]) => ({ providerId, apiKey })) }
    }),
    subscribe: (handler) => {
      onChange = handler
      return unsubscribe
    },
    log,
  }
  return { value, unsubscribe, log, change: () => onChange?.() }
}

describe("host provider key overlay", () => {
  it("loads the sealed keys and resolves a provider the settings have no key for", async () => {
    await loadHostProviderKeys({
      load: async () => ({ keys: [{ providerId: "deepseek", apiKey: "sk-host" }] }),
    })
    const snapshot = createProviderSettingsSnapshot({
      defaultProvider: "deepseek",
      providerSettings: { deepseek: { enabled: true, apiKey: "" } },
      customProviders: undefined,
    })
    expect(snapshot.providers.deepseek?.apiKey).toBe("sk-host")
  })

  it("reloads on every change and empties the overlay when torn down", async () => {
    const harness = deps([[["deepseek", "k1"]], [["deepseek", "k2"]]])
    const { ready, stop } = installHostProviderKeys(harness.value)
    await ready
    expect(hostProviderKey("deepseek")).toBe("k1")
    harness.change()
    await flush()
    expect(hostProviderKey("deepseek")).toBe("k2")
    stop()
    expect(harness.unsubscribe).toHaveBeenCalled()
    expect(hostProviderKey("deepseek")).toBeUndefined()
  })

  it("keeps the keys it had when a reload fails", async () => {
    const harness = deps([[["deepseek", "k1"]], new Error("store locked")])
    const { ready, stop } = installHostProviderKeys(harness.value)
    await ready
    harness.change()
    await flush()
    expect(hostProviderKey("deepseek")).toBe("k1")
    expect(harness.log).toHaveBeenCalledWith("warn", expect.stringContaining("store locked"))
    stop()
  })
})
