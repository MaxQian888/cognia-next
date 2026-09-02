/** @jest-environment node */
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: {
        defaultProvider: "openai",
        providerSettings: { openai: { enabled: true, apiKey: "sk-live" } },
        customProviders: [],
      },
    }),
  },
}))

import {
  __resetProviderOperationExecutorForTests,
  getProviderOperationExecutor,
  providerOperationHandlerRegistry,
} from "./index"

describe("getProviderOperationExecutor", () => {
  beforeEach(() => __resetProviderOperationExecutorForTests())

  it("is wired: built-in handlers registered, live settings read, host surfaces detected", async () => {
    const executor = getProviderOperationExecutor()
    expect(getProviderOperationExecutor()).toBe(executor)
    expect(providerOperationHandlerRegistry.listFor("capabilities.read").length).toBeGreaterThan(0)
    const result = await executor.execute({
      operationId: "capabilities.read",
      providerId: "openai",
      scopes: ["provider:read"],
      surface: "sidecar",
      input: {},
    })
    expect(result).toMatchObject({ ok: true, providerId: "openai", support: "derived" })
    expect(result.ok && (result.output as { cells: unknown[] }).cells).toHaveLength(50)
  })
})
