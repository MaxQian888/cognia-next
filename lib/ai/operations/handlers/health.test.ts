/** @jest-environment node */
jest.mock("@/lib/provider-diagnostics/probe", () => ({
  runProviderProbe: jest.fn(async () => ({
    reachable: true,
    capabilityVerified: true,
    durationMs: 3,
  })),
}))
const probe = jest.requireMock("@/lib/provider-diagnostics/probe") as {
  runProviderProbe: jest.Mock
}

import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { authStatusHandler, healthProbeHandler } from "./health"

const base: ResolvedProvider = {
  kind: "resolved",
  providerId: "openai",
  protocol: "openai",
  apiKey: "sk-1",
  baseURL: "https://api.openai.com/v1",
  model: "gpt-x",
  isCustomProvider: false,
  useProxy: false,
}
const settings = { defaultProvider: "openai", providers: {}, customProviders: [] }

describe("auth.status", () => {
  const ctx = (provider: ResolvedProvider) => ({
    descriptor: getProviderOperationDescriptor("auth.status")!,
    provider,
    settings,
    request: {
      operationId: "auth.status" as const,
      scopes: ["provider:read" as const],
      surface: "sidecar" as const,
      input: {},
    },
  })

  it("reports an api key without exposing it, keyless local as configured, and bedrock chains as other", async () => {
    const keyed = await authStatusHandler.handler(ctx(base))
    expect(keyed).toMatchObject({ configured: true, method: "api-key" })
    expect(keyed.credentialFingerprint).not.toContain("sk-1")
    expect(
      await authStatusHandler.handler(
        ctx({ ...base, apiKey: undefined, baseURL: "http://127.0.0.1:11434" })
      )
    ).toEqual({
      configured: true,
      method: "none",
    })
    expect(
      await authStatusHandler.handler(ctx({ ...base, apiKey: undefined, baseURL: undefined }))
    ).toEqual({
      configured: false,
      method: "none",
    })
    expect(
      await authStatusHandler.handler(
        ctx({
          ...base,
          apiKey: undefined,
          bedrock: { authMode: "iam", accessKeyId: "AKIA" } as never,
        })
      )
    ).toMatchObject({ configured: true, method: "other" })
  })
})

describe("health.probe", () => {
  it("delegates to the diagnostics probe with the resolved provider", async () => {
    const result = await healthProbeHandler.handler({
      descriptor: getProviderOperationDescriptor("health.probe")!,
      provider: base,
      settings,
      request: {
        operationId: "health.probe",
        scopes: ["provider:read", "provider:invoke"],
        surface: "sidecar",
        input: { timeoutMs: 5 },
      },
    })
    expect(result.reachable).toBe(true)
    expect(probe.runProviderProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        protocol: "openai",
        apiKey: "sk-1",
        model: "gpt-x",
      }),
      expect.objectContaining({ timeoutMs: 5 })
    )
  })
})
