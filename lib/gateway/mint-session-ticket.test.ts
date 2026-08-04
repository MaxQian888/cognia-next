import type { GatewayRoutingSnapshot } from "@/types/gateway"

const flagMock = jest.fn()
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  isAgentExecutionFlagEnabled: (...args: unknown[]) => flagMock(...args),
}))

const statusMock = jest.fn()
const mintMock = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayGetStatus: () => statusMock(),
  gatewayMintRouteTicket: (...args: unknown[]) => mintMock(...args),
}))

const buildSnapshotMock = jest.fn()
jest.mock("@/lib/gateway/snapshot-publisher", () => ({
  buildGatewaySnapshot: (...args: unknown[]) => buildSnapshotMock(...args),
  loadSnapshotProfileMeta: () => Promise.resolve(undefined),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: {
        defaultProvider: "anthropic",
        providerSettings: {},
        customProviders: [],
        modelMappings: [],
        routingConfig: { strategy: "difficulty", maxFallbackAttempts: 2 },
      },
    }),
  },
}))

import { candidatesForModel, mintSessionRouteTicket } from "./mint-session-ticket"

function snapshot(overrides: Partial<GatewayRoutingSnapshot> = {}): GatewayRoutingSnapshot {
  return {
    generatedAtMs: 1,
    aliases: [],
    providers: [
      {
        id: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        enabled: true,
        models: ["claude-opus-5"],
        deploymentId: "dep_anthropic",
      },
    ],
    ...overrides,
  }
}

const INPUT = {
  sessionId: "sess_1",
  executionFingerprint: "fp_1",
  model: "claude-opus-5",
  routePolicy: "gateway-preferred",
}

beforeEach(() => {
  jest.clearAllMocks()
  flagMock.mockReturnValue(true)
  statusMock.mockResolvedValue({ running: true, boundPort: 8317 })
  buildSnapshotMock.mockReturnValue(snapshot())
  mintMock.mockResolvedValue({ ticket: { ticketId: "tkt_1" }, secret: "sk-ticket" })
})

describe("candidatesForModel", () => {
  it("expands an alias into its ordered deployment candidates", () => {
    const withAlias = snapshot({
      aliases: [
        {
          alias: "fast",
          entries: [
            { providerId: "anthropic", modelId: "claude-opus-5" },
            { providerId: "openai", modelId: "gpt-5" },
          ],
        },
      ],
      providers: [
        ...snapshot().providers,
        {
          id: "openai",
          protocol: "openai",
          baseUrl: "https://api.openai.com",
          enabled: true,
          models: ["gpt-5"],
          deploymentId: "dep_openai",
        },
      ],
    })
    expect(candidatesForModel(withAlias, "fast")).toEqual([
      { deploymentId: "dep_anthropic", modelId: "claude-opus-5" },
      { deploymentId: "dep_openai", modelId: "gpt-5" },
    ])
  })

  it("matches a bare model id against every enabled provider that lists it", () => {
    expect(candidatesForModel(snapshot(), "claude-opus-5")).toEqual([
      { deploymentId: "dep_anthropic", modelId: "claude-opus-5" },
    ])
  })

  it("honours a provider-pinned id", () => {
    expect(candidatesForModel(snapshot(), "anthropic:claude-opus-5")).toEqual([
      { deploymentId: "dep_anthropic", modelId: "claude-opus-5" },
    ])
    expect(candidatesForModel(snapshot(), "openai:claude-opus-5")).toEqual([])
  })

  it("skips disabled providers, which mint would reject as unservable", () => {
    const disabled = snapshot({
      providers: [{ ...snapshot().providers[0]!, enabled: false }],
    })
    expect(candidatesForModel(disabled, "claude-opus-5")).toEqual([])
  })

  it("falls back to the provider id when no deployment profile exists", () => {
    const legacy = snapshot({
      providers: [{ ...snapshot().providers[0]!, deploymentId: undefined }],
    })
    expect(candidatesForModel(legacy, "claude-opus-5")).toEqual([
      { deploymentId: "anthropic", modelId: "claude-opus-5" },
    ])
  })
})

describe("mintSessionRouteTicket", () => {
  it("mints against the running listener and returns the one-shot secret", async () => {
    await expect(mintSessionRouteTicket(INPUT)).resolves.toEqual({
      endpoint: "http://127.0.0.1:8317/v1",
      ticketId: "tkt_1",
      secret: "sk-ticket",
    })
    expect(mintMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_1",
        executionFingerprint: "fp_1",
        routePolicy: "gateway-preferred",
        candidates: [{ deploymentId: "dep_anthropic", modelId: "claude-opus-5" }],
        credentialAffinity: "session-sticky",
        allowAuthFailover: false,
      })
    )
    expect(buildSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routingConfig: { strategy: "difficulty", maxFallbackAttempts: 2 },
      }),
      expect.any(Number),
      undefined
    )
  })

  it("allows auth failover only when more than one candidate is frozen", async () => {
    buildSnapshotMock.mockReturnValue(
      snapshot({
        providers: [
          snapshot().providers[0]!,
          {
            id: "bedrock",
            protocol: "anthropic",
            baseUrl: "https://bedrock",
            enabled: true,
            models: ["claude-opus-5"],
            deploymentId: "dep_bedrock",
          },
        ],
      })
    )
    await mintSessionRouteTicket(INPUT)
    expect(mintMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialAffinity: "sticky-with-failover",
        allowAuthFailover: true,
      })
    )
  })

  it("does not mint while the capability flag is off", async () => {
    flagMock.mockReturnValue(false)
    await expect(mintSessionRouteTicket(INPUT)).resolves.toBeUndefined()
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("does not mint when the listener is not running", async () => {
    statusMock.mockResolvedValue({ running: false, boundPort: null })
    await expect(mintSessionRouteTicket(INPUT)).resolves.toBeUndefined()
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("does not mint when the snapshot cannot serve the model", async () => {
    await expect(
      mintSessionRouteTicket({ ...INPUT, model: "some-unrouted-model" })
    ).resolves.toBeUndefined()
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("degrades to undefined rather than throwing when Rust refuses", async () => {
    mintMock.mockRejectedValue(new Error("candidate is not servable"))
    await expect(mintSessionRouteTicket(INPUT)).resolves.toBeUndefined()
  })
})
