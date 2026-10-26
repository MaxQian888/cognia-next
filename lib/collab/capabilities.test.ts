import { readFileSync } from "node:fs"
import path from "node:path"

import {
  COLLAB_ACTIONS,
  COLLAB_FEATURE_KEYS,
  COLLAB_FEATURE_REASONS,
  COLLAB_FEATURE_STATES,
  ORG_CAPABILITIES_HEALTH_FEATURE,
  OrgCapabilitiesParseError,
  admitsNew,
  allowsMutation,
  allowsRead,
  featureUnavailableRefusal,
  fetchOrgCapabilities,
  hasAction,
  parseOrgCapabilities,
} from "./capabilities"
import { CollabError } from "./client"

interface ContractFile {
  schemaVersion: number
  featureKeys: string[]
  featureStates: Record<string, string>
  reasons: string[]
  actions: { action: string }[]
  exampleResponse: Record<string, unknown>
}

const contract = JSON.parse(
  readFileSync(path.join(__dirname, "../../protocol/collab-capabilities-v1.json"), "utf8")
) as ContractFile

const scope = { orgId: "org_alpha", workspaceId: "ws_alpha" }

describe("capabilities contract", () => {
  it("pins every finite list to protocol/collab-capabilities-v1.json", () => {
    expect(contract.schemaVersion).toBe(1)
    expect([...COLLAB_FEATURE_KEYS]).toEqual(contract.featureKeys)
    expect([...COLLAB_FEATURE_STATES]).toEqual(Object.keys(contract.featureStates))
    expect([...COLLAB_FEATURE_REASONS]).toEqual(contract.reasons)
    expect([...COLLAB_ACTIONS]).toEqual(contract.actions.map((entry) => entry.action))
  })

  it("parses the contract's example response", () => {
    const parsed = parseOrgCapabilities(contract.exampleResponse, scope)
    expect(parsed.standing).toEqual({
      orgRole: "member",
      workspaceRole: "member",
      via: "membership",
      guest: false,
    })
    expect(hasAction(parsed, "execution.request")).toBe(true)
    expect(hasAction(parsed, "workspace.members.manage")).toBe(false)
    expect(parsed.features["shared-chat"]).toEqual({
      key: "shared-chat",
      state: "available",
      reason: null,
      policyRevision: 4,
    })
    expect(parsed.features["shared-chat-execution"].reason).toBe("feature_paused")
    expect(parsed.features["environment-binding"].state).toBe("read-only")
  })
})

describe("parseOrgCapabilities", () => {
  const base = () => structuredClone(contract.exampleResponse)

  it("refuses an answer for another org or workspace", () => {
    expect(() => parseOrgCapabilities(base(), { ...scope, orgId: "org_beta" })).toThrow(
      OrgCapabilitiesParseError
    )
    expect(() => parseOrgCapabilities(base(), { ...scope, workspaceId: null })).toThrow(
      OrgCapabilitiesParseError
    )
  })

  it("refuses an unknown schema version", () => {
    expect(() => parseOrgCapabilities({ ...base(), schemaVersion: 2 }, scope)).toThrow(/schema 2/)
  })

  it("drops unknown actions and features, and reads an unknown state as off", () => {
    const raw = base()
    raw.actions = ["workspace.read", "root.everything", 42]
    raw.features = [
      { key: "shared-chat", state: "teleport", reason: "because", policyRevision: 1 },
      { key: "future-feature", state: "available", reason: null, policyRevision: 1 },
    ]
    const parsed = parseOrgCapabilities(raw, scope)
    expect([...parsed.actions]).toEqual(["workspace.read"])
    expect(parsed.features["shared-chat"]).toMatchObject({
      state: "off",
      reason: "deployment_disabled",
    })
    // Features the server did not mention are not offered.
    expect(parsed.features["canvas-collaboration"]).toMatchObject({ state: "off" })
  })

  it("keeps the first decision when a key is duplicated", () => {
    const raw = base()
    raw.features = [
      { key: "shared-chat", state: "read-only", reason: "feature_killed", policyRevision: 9 },
      { key: "shared-chat", state: "available", reason: null, policyRevision: 10 },
    ]
    expect(parseOrgCapabilities(raw, scope).features["shared-chat"].state).toBe("read-only")
  })

  it("never reports a reason for an available feature", () => {
    const raw = base()
    raw.features = [
      { key: "shared-chat", state: "available", reason: "feature_paused", policyRevision: 1 },
    ]
    expect(parseOrgCapabilities(raw, scope).features["shared-chat"].reason).toBeNull()
  })

  it("fills a missing reason for a closed feature instead of trusting silence", () => {
    const raw = base()
    raw.features = [{ key: "shared-chat", state: "existing-only", policyRevision: 1 }]
    expect(parseOrgCapabilities(raw, scope).features["shared-chat"].reason).toBe(
      "feature_not_offered"
    )
  })
})

describe("state helpers", () => {
  const decision = (state: (typeof COLLAB_FEATURE_STATES)[number]) => ({
    key: "shared-chat" as const,
    state,
    reason: null,
    policyRevision: 0,
  })

  it.each([
    ["available", true, true, true],
    ["existing-only", false, true, true],
    ["read-only", false, false, true],
    ["off", false, false, false],
  ] as const)("%s → new %s, mutate %s, read %s", (state, fresh, mutate, read) => {
    expect(admitsNew(decision(state))).toBe(fresh)
    expect(allowsMutation(decision(state))).toBe(mutate)
    expect(allowsRead(decision(state))).toBe(read)
  })
})

describe("fetchOrgCapabilities", () => {
  it("returns the parsed answer", async () => {
    const client = {
      capabilities: jest.fn().mockResolvedValue(contract.exampleResponse),
      health: jest.fn(),
    }
    const result = await fetchOrgCapabilities(client, scope)
    expect(result.status).toBe("ready")
    expect(client.capabilities).toHaveBeenCalledWith("org_alpha", "ws_alpha", undefined)
    expect(client.health).not.toHaveBeenCalled()
  })

  it("tells an older server apart from a hidden workspace", async () => {
    const notFound = new CollabError(404, "not found")
    const older = {
      capabilities: jest.fn().mockRejectedValue(notFound),
      health: jest.fn().mockResolvedValue({ status: "ok", features: ["shared-chat"] }),
    }
    await expect(fetchOrgCapabilities(older, scope)).resolves.toEqual({ status: "unsupported" })

    const current = {
      capabilities: jest.fn().mockRejectedValue(notFound),
      health: jest
        .fn()
        .mockResolvedValue({ status: "ok", features: [ORG_CAPABILITIES_HEALTH_FEATURE] }),
    }
    await expect(fetchOrgCapabilities(current, scope)).resolves.toEqual({ status: "hidden" })
  })

  it("rethrows every other failure", async () => {
    const client = {
      capabilities: jest.fn().mockRejectedValue(new CollabError(403, "forbidden")),
      health: jest.fn(),
    }
    await expect(fetchOrgCapabilities(client, scope)).rejects.toMatchObject({ status: 403 })
    expect(client.health).not.toHaveBeenCalled()
  })
})

describe("featureUnavailableRefusal", () => {
  it("recognises the server's feature refusal and keeps its reason", () => {
    expect(
      featureUnavailableRefusal(new CollabError(403, "feature_unavailable", "feature_killed"))
    ).toEqual({ reason: "feature_killed" })
  })

  it("does not mistake a permission refusal for a feature refusal", () => {
    expect(featureUnavailableRefusal(new CollabError(403, "forbidden", "not_a_member"))).toBeNull()
    expect(featureUnavailableRefusal(new Error("feature_unavailable"))).toBeNull()
  })

  it("falls back to a generic reason when the server names an unknown one", () => {
    expect(
      featureUnavailableRefusal(new CollabError(403, "feature_unavailable", "solar_flare"))
    ).toEqual({ reason: "feature_not_offered" })
  })
})
