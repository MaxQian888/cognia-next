/**
 * @jest-environment node
 */
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { ProviderOperationProfile } from "@cognia/provider-types"

import type { ProviderOperationExecutor } from "@/lib/ai/operations"

import type { ResolvedConfig } from "../config/schema"
import {
  cliProviderSettingsSnapshot,
  configuredProviderIds,
  createCliProviderExecutor,
} from "./local"

const CONFIG: ResolvedConfig = {
  provider: "openai",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: {
    anthropic: { protocol: "anthropic", authToken: "oauth-token" },
    openai: { apiKey: "sk-openai", model: "gpt-4o" },
    "my-vllm": { protocol: "openai", baseURL: "http://10.0.0.5:8000/v1" },
    "my-gemini-proxy": { protocol: "google", apiKey: "k", baseURL: "https://proxy.example" },
    google: { protocol: "google", apiKey: "g" },
    idle: {},
  },
  cwd: "/workspace",
}

describe("cliProviderSettingsSnapshot", () => {
  const snapshot = cliProviderSettingsSnapshot(CONFIG)

  it("puts catalog ids under providers, with the subscription token as the key", () => {
    expect(snapshot.defaultProvider).toBe("openai")
    expect(snapshot.providers.anthropic).toEqual({
      enabled: true,
      apiKey: "oauth-token",
      apiProtocol: "anthropic",
    })
    expect(snapshot.providers.openai).toEqual({
      enabled: true,
      apiKey: "sk-openai",
      defaultModel: "gpt-4o",
    })
  })

  it("turns an id the catalog does not know into a custom provider", () => {
    expect(snapshot.customProviders).toEqual([
      {
        id: "my-vllm",
        name: "my-vllm",
        enabled: true,
        protocol: "openai",
        baseURL: "http://10.0.0.5:8000/v1",
      },
      {
        id: "my-gemini-proxy",
        name: "my-gemini-proxy",
        enabled: true,
        protocol: "google",
        apiKey: "k",
        baseURL: "https://proxy.example",
      },
    ])
  })

  it("speaks gemini to the settings entry for a google built-in", () => {
    expect(snapshot.providers.google).toEqual({ enabled: true, apiKey: "g", apiProtocol: "gemini" })
  })
})

describe("configuredProviderIds", () => {
  it("lists credentialed or addressed providers, active first, and skips empty entries", () => {
    expect(configuredProviderIds(CONFIG)).toEqual([
      "openai",
      "anthropic",
      "google",
      "my-gemini-proxy",
      "my-vllm",
    ])
  })

  it("keeps the active provider even when it has no entry", () => {
    expect(configuredProviderIds({ ...CONFIG, provider: "deepseek", providers: {} })).toEqual([
      "deepseek",
    ])
  })
})

describe("createCliProviderExecutor", () => {
  it("addresses the sidecar surface with the descriptor's own scopes", async () => {
    const execute = jest.fn(async () => ({
      ok: true as const,
      operationId: "models.list" as const,
      providerId: "openai",
      support: "native" as const,
      output: { models: [] },
    }))
    const executor = createCliProviderExecutor(CONFIG, {
      executor: { execute } as unknown as ProviderOperationExecutor,
    })
    await executor.execute("models.list", "openai", { refresh: true }, { deploymentRef: "dep-1" })
    expect(execute).toHaveBeenCalledWith(
      {
        operationId: "models.list",
        providerId: "openai",
        scopes: ["provider:read"],
        surface: "sidecar",
        input: { refresh: true },
        deploymentRef: "dep-1",
      },
      {}
    )
  })

  it("runs the real registry over the CLI config for a pure operation", async () => {
    const executor = createCliProviderExecutor(CONFIG)
    const result = await executor.execute<ProviderOperationProfile>(
      "capabilities.read",
      "openai",
      {}
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.providerId).toBe("openai")
    expect(result.output.cells.length).toBeGreaterThan(40)
    expect(result.output.cells.find((cell) => cell.operationId === "models.list")).toMatchObject({
      support: "native",
    })
  })

  it("reports a provider the config does not carry as a resolution failure", async () => {
    const executor = createCliProviderExecutor(CONFIG)
    const result = await executor.execute("capabilities.read", "nowhere", {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.availability).not.toBe("ready")
  })
})
