/** @jest-environment node */
jest.mock("../persistence", () => ({
  providerOperationPersistence: { writeSnapshots: jest.fn(async () => undefined) },
}))
const persistence = jest.requireMock("../persistence") as {
  providerOperationPersistence: { writeSnapshots: jest.Mock }
}

import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { capabilitiesReadHandler } from "./capabilities"

function provider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    kind: "resolved",
    providerId: "openai",
    protocol: "openai",
    apiKey: "sk-test",
    baseURL: undefined,
    model: undefined,
    isCustomProvider: false,
    useProxy: false,
    ...overrides,
  }
}

describe("capabilities.read handler", () => {
  it("returns the full profile for a built-in provider, surface-aware", async () => {
    const profile = await capabilitiesReadHandler.handler({
      descriptor: getProviderOperationDescriptor("capabilities.read")!,
      provider: provider(),
      settings: { defaultProvider: "openai", providers: {}, customProviders: [] },
      request: {
        operationId: "capabilities.read",
        scopes: ["provider:read"],
        surface: "sidecar",
        input: {},
      },
    })
    expect(profile.providerId).toBe("openai")
    expect(profile.cells).toHaveLength(50)
    expect(profile.cells.every((c) => c.support !== "unknown")).toBe(true)
    // In a node process only the sidecar surface exists, so an operation
    // whose descriptor names only renderer/sidecar is still reachable, and
    // one that needs the renderer is not.
    const files = profile.cells.find((c) => c.operationId === "files.upload")
    expect(files?.availability).toBe("ready")
  })

  it("caches the cells per deployment and account without exposing the key", async () => {
    await capabilitiesReadHandler.handler({
      descriptor: getProviderOperationDescriptor("capabilities.read")!,
      provider: provider(),
      settings: { defaultProvider: "openai", providers: {}, customProviders: [] },
      request: {
        operationId: "capabilities.read",
        scopes: ["provider:read"],
        surface: "sidecar",
        deploymentRef: "openai-main",
        input: {},
      },
    })
    const write = persistence.providerOperationPersistence.writeSnapshots.mock.calls.at(-1)?.[0]
    expect(write).toMatchObject({ providerId: "openai", deploymentRef: "openai-main" })
    expect(write.accountRef).not.toContain("sk-test")
    expect(write.cells.length).toBeGreaterThan(0)
  })

  it("treats a custom provider by protocol with vendor surfaces unknown", async () => {
    const profile = await capabilitiesReadHandler.handler({
      descriptor: getProviderOperationDescriptor("capabilities.read")!,
      provider: provider({ providerId: "my-relay", isCustomProvider: true, protocol: "anthropic" }),
      settings: { defaultProvider: "openai", providers: {}, customProviders: [] },
      request: {
        operationId: "capabilities.read",
        scopes: ["provider:read"],
        surface: "sidecar",
        input: {},
      },
    })
    expect(profile.cells.find((c) => c.operationId === "tokens.count")?.support).toBe("native")
    expect(profile.cells.find((c) => c.operationId === "files.upload")?.support).toBe("unknown")
  })
})
