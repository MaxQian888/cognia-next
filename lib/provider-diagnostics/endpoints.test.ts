/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"

import {
  applyProviderEndpoint,
  collectProviderEndpointCandidates,
  ProviderEndpointConflictError,
  rollbackProviderEndpoint,
  compareProviderEndpointsFree,
  extractCcswitchProviderEndpoints,
} from "./endpoints"

describe("provider diagnostic endpoints", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await getDb().open()
  })

  it("imports only matching read-only CCSwitch endpoints and drops URL secrets", () => {
    expect(
      extractCcswitchProviderEndpoints("anthropic", [
        {
          id: "claude-relay",
          name: "Claude Relay",
          kind: "claude",
          baseUrl: "https://relay.example/v1?token=secret",
          apiKey: "never-export",
        },
        { id: "codex", name: "Codex", kind: "codex", baseUrl: "https://openai.example/v1" },
        { id: "bad", name: "Claude Bad", kind: "claude", baseUrl: "https://user:pass@bad.example" },
      ])
    ).toEqual(["https://relay.example/v1"])
  })

  afterEach(async () => {
    __resetDbForTesting()
  })

  it("accepts only explicit sources, removes secrets, and de-duplicates URLs", () => {
    expect(
      collectProviderEndpointCandidates({
        providerId: "openai",
        current: "https://api.openai.com/v1?token=secret",
        catalog: ["https://api.openai.com/v1"],
        user: ["https://relay.example.com/v1"],
        ccswitch: ["https://relay.example.com/v1/"],
      })
    ).toEqual([
      expect.objectContaining({ source: "current", url: "https://api.openai.com/v1" }),
      expect.objectContaining({ source: "user", url: "https://relay.example.com/v1" }),
    ])
  })

  it("applies an endpoint with a rollback journal and rolls back by compare-and-swap", async () => {
    let endpoint = "https://old.example.com/v1"
    const compareAndSwap = jest.fn(async (_providerId, expected, next) => {
      if (endpoint !== expected) return false
      endpoint = next
      return true
    })

    const change = await applyProviderEndpoint(
      {
        providerId: "openai",
        endpoint: "https://new.example.com/v1",
        expectedCurrentEndpoint: endpoint,
      },
      { compareAndSwap, now: () => 100, randomUUID: () => "change-1" }
    )

    expect(endpoint).toBe("https://new.example.com/v1")
    expect(await getDb().providerEndpointChanges.get("change-1")).toEqual(change)

    await rollbackProviderEndpoint("change-1", {
      compareAndSwap,
      now: () => 200,
    })
    expect(endpoint).toBe("https://old.example.com/v1")
    expect((await getDb().providerEndpointChanges.get("change-1"))?.rolledBackAt).toBe(200)
  })

  it("does not overwrite a later manual endpoint edit during rollback", async () => {
    await getDb().providerEndpointChanges.put({
      id: "change-conflict",
      providerId: "openai",
      previousEndpoint: "https://old.example.com/v1",
      appliedEndpoint: "https://new.example.com/v1",
      appliedAt: 100,
    })
    const compareAndSwap = jest.fn(async () => false)

    await expect(
      rollbackProviderEndpoint("change-conflict", { compareAndSwap })
    ).rejects.toBeInstanceOf(ProviderEndpointConflictError)
    expect(
      (await getDb().providerEndpointChanges.get("change-conflict"))?.rolledBackAt
    ).toBeUndefined()
  })

  it("ranks free comparison by reachability and only recommends authenticated capability checks", async () => {
    const results = await compareProviderEndpointsFree(
      [
        {
          id: "slow",
          providerId: "openai",
          endpoint: "https://slow.example.com/v1",
          credentialFingerprint: "credential:primary",
          capability: "probe",
          credentials: { protocol: "openai", apiKey: "secret" },
        },
        {
          id: "fast-unverified",
          providerId: "openai",
          endpoint: "https://fast.example.com/v1",
          credentialFingerprint: "credential:primary",
          capability: "probe",
          credentials: { protocol: "openai", apiKey: "secret" },
        },
      ],
      {
        probe: async (target) =>
          target.id === "slow"
            ? { reachable: true, authenticated: true, capabilityVerified: true, durationMs: 40 }
            : { reachable: true, authenticated: false, capabilityVerified: false, durationMs: 5 },
      }
    )

    expect(results.map((result) => result.targetId)).toEqual(["fast-unverified", "slow"])
    expect(results.find((result) => result.recommended)?.targetId).toBe("slow")
  })
})
