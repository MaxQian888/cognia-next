const setPluginConfig = jest.fn(async (_id: string, _config: Record<string, unknown>) => undefined)
const storeSetPluginConfig = jest.fn()
const managerNotify = jest.fn(async (_id: string, _config: Record<string, unknown>) => undefined)
const warn = jest.fn()

jest.mock("@/lib/db/plugins", () => ({
  setPluginConfig: (id: string, config: Record<string, unknown>) => setPluginConfig(id, config),
}))
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: () => ({ setPluginConfig: storeSetPluginConfig }) },
}))
jest.mock("./manager", () => ({
  getPluginManager: () => ({ notifyPluginConfigChanged: managerNotify }),
}))
jest.mock("./logger", () => ({
  loggers: { manager: { warn: (...args: unknown[]) => warn(...args) } },
}))

import { applyPluginConfig } from "./apply-plugin-config"

describe("applyPluginConfig", () => {
  beforeEach(() => jest.clearAllMocks())

  it("writes the row, updates the runtime store and notifies the manager", async () => {
    await applyPluginConfig("p", { a: 1 })
    expect(setPluginConfig).toHaveBeenCalledWith("p", { a: 1 })
    expect(storeSetPluginConfig).toHaveBeenCalledWith("p", { a: 1 })
    expect(managerNotify).toHaveBeenCalledWith("p", { a: 1 })
  })

  it("uses an injected notifier", async () => {
    const notifyPluginConfigChanged = jest.fn(async () => undefined)
    await applyPluginConfig("p", { b: 2 }, { notifyPluginConfigChanged })
    expect(notifyPluginConfigChanged).toHaveBeenCalledWith("p", { b: 2 })
    expect(managerNotify).not.toHaveBeenCalled()
  })

  it("fails when the row cannot be written, and only logs a failed notification", async () => {
    setPluginConfig.mockRejectedValueOnce(new Error("quota"))
    await expect(applyPluginConfig("p", {})).rejects.toThrow("quota")
    expect(managerNotify).not.toHaveBeenCalled()

    managerNotify.mockRejectedValueOnce(new Error("python host down"))
    await expect(applyPluginConfig("p", {})).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith("[plugin:p] config change notification failed", {
      error: "python host down",
    })
  })
})
