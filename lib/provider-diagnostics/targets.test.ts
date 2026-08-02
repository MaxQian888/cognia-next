import type { AppSettings } from "@cognia/agent-config-types"

import { resolveProviderDiagnosticTargets } from "./targets"

describe("resolveProviderDiagnosticTargets", () => {
  it("expands selected credentials and endpoints without deriving identity from secrets", async () => {
    const settings = {
      providerSettings: {
        openai: {
          providerId: "openai",
          enabled: true,
          apiKey: "primary-secret",
          apiKeys: ["pool-secret-a", "pool-secret-b"],
          baseURL: "https://api.openai.com/v1",
        },
      },
    } as unknown as AppSettings

    const targets = await resolveProviderDiagnosticTargets(
      {
        providerId: "openai",
        modelIds: ["gpt-5.4"],
        capability: "text-generation",
        credentialIds: ["primary", "pool:1"],
        endpoints: ["https://api.openai.com/v1", "https://relay.example/v1"],
        appSettings: settings,
      },
      {
        resolveAttempt: async () => ({
          providerCredentials: {
            protocol: "openai",
            apiKey: "primary-secret",
            baseURL: "https://api.openai.com/v1",
          },
        }),
      }
    )

    expect(targets).toHaveLength(4)
    expect(targets.map((target) => target.credentialFingerprint)).toEqual([
      "credential:openai:primary",
      "credential:openai:primary",
      "credential:openai:pool:1",
      "credential:openai:pool:1",
    ])
    expect(targets[2].credentials.apiKey).toBe("pool-secret-b")
    expect(
      JSON.stringify(
        targets.map(({ id, credentialFingerprint }) => ({ id, credentialFingerprint }))
      )
    ).not.toContain("secret")
    expect(targets.every((target) => target.billable)).toBe(true)
    expect(targets.every((target) => typeof target.estimatedMaxCostUsd === "number")).toBe(true)
  })

  it("marks probes and zero-price local models as non-billable", async () => {
    const targets = await resolveProviderDiagnosticTargets(
      {
        providerId: "ollama",
        modelIds: ["llama3"],
        capability: "probe",
        appSettings: {
          providerSettings: {
            ollama: {
              providerId: "ollama",
              enabled: true,
              baseURL: "http://127.0.0.1:11434",
            },
          },
        } as unknown as AppSettings,
      },
      {
        resolveAttempt: async () => ({
          providerCredentials: {
            protocol: "openai",
            baseURL: "http://127.0.0.1:11434/v1",
          },
        }),
      }
    )

    expect(targets).toHaveLength(1)
    expect(targets[0]).toEqual(expect.objectContaining({ billable: false, estimatedMaxCostUsd: 0 }))
  })
})
