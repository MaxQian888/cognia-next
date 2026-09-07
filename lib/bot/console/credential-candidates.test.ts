import {
  bindingForCandidate,
  buildCredentialCandidates,
  credentialSourceForSlot,
  selectedCandidateValue,
} from "./credential-candidates"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { IntegrationAccount } from "@/types/plugin/plugin-integration"

function account(overrides: Partial<IntegrationAccount> = {}): IntegrationAccount {
  return {
    id: "iacc_1",
    pluginId: "github-delivery",
    integrationId: "github",
    providerId: "github-oauth",
    authSessionId: "sess_1",
    remoteAccountId: "octocat",
    label: "Octocat",
    enabled: true,
    health: "healthy",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as IntegrationAccount
}

function adapter(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "adp_1",
    type: "slack",
    displayName: "Ops Slack",
    enabled: true,
    transportMode: "socket-mode",
    settings: {},
    credentialsRef: { keyringService: "s", accounts: [] },
    trigger: {},
    defaultMode: "assistant",
    ...overrides,
  } as AdapterInstanceRow
}

describe("credentialSourceForSlot", () => {
  it("offers both when the slot narrows nothing", () => {
    expect(credentialSourceForSlot({})).toBe("either")
  })

  it("reads a built-in platform name as a connector slot", () => {
    expect(credentialSourceForSlot({ integration: "slack" })).toBe("adapter")
  })

  it("reads anything else as an integration slot", () => {
    expect(credentialSourceForSlot({ integration: "github" })).toBe("integration")
  })

  it("recognises a plugin-owned connector kind from the adapters that exist", () => {
    // Plugin kinds are not in `ALL_PLATFORM_KINDS`, so the static check alone
    // would offer the wrong list for one.
    expect(credentialSourceForSlot({ integration: "acme-chat" })).toBe("integration")
    expect(credentialSourceForSlot({ integration: "acme-chat" }, ["acme-chat"])).toBe("adapter")
  })
})

describe("buildCredentialCandidates", () => {
  it("offers only matching integration accounts for an integration slot", () => {
    const candidates = buildCredentialCandidates({
      slot: { id: "gh", integration: "github" },
      accounts: [account(), account({ id: "iacc_2", integrationId: "gitlab", label: "GL" })],
      adapters: [adapter()],
    })
    expect(candidates).toEqual([
      {
        value: "iacc_1",
        kind: "integration-account",
        label: "Octocat",
        detail: "github",
        disabled: false,
      },
    ])
  })

  it("offers only matching adapters for a connector slot", () => {
    const candidates = buildCredentialCandidates({
      slot: { id: "im", integration: "slack" },
      accounts: [account()],
      adapters: [adapter(), adapter({ id: "adp_2", type: "telegram", displayName: "TG" })],
    })
    expect(candidates.map((c) => c.value)).toEqual(["adp_1"])
    expect(candidates[0]!.kind).toBe("adapter")
  })

  it("offers both when the slot narrows nothing", () => {
    const candidates = buildCredentialCandidates({
      slot: { id: "any" },
      accounts: [account()],
      adapters: [adapter()],
    })
    expect(candidates.map((c) => c.kind).sort()).toEqual(["adapter", "integration-account"])
  })

  it("puts enabled candidates first, then sorts by label", () => {
    // A list ordered purely by name buries the only usable account under the
    // revoked ones.
    const candidates = buildCredentialCandidates({
      slot: { id: "gh", integration: "github" },
      accounts: [
        account({ id: "a", label: "Alpha", enabled: false }),
        account({ id: "z", label: "Zulu" }),
        account({ id: "b", label: "Bravo" }),
      ],
      adapters: [],
    })
    expect(candidates.map((c) => c.label)).toEqual(["Bravo", "Zulu", "Alpha"])
  })

  it("keeps a disabled candidate selectable and says so", () => {
    const [candidate] = buildCredentialCandidates({
      slot: { id: "gh", integration: "github" },
      accounts: [account({ enabled: false })],
      adapters: [],
    })
    expect(candidate).toMatchObject({ value: "iacc_1", disabled: true })
  })

  it("falls back through the label chain rather than rendering a blank row", () => {
    const [candidate] = buildCredentialCandidates({
      slot: { id: "gh", integration: "github" },
      accounts: [account({ label: "" })],
      adapters: [],
    })
    expect(candidate!.label).toBe("octocat")
  })

  it("offers nothing when a slot's integration has no accounts", () => {
    expect(
      buildCredentialCandidates({
        slot: { id: "gh", integration: "github" },
        accounts: [account({ integrationId: "gitlab" })],
        adapters: [],
      })
    ).toEqual([])
  })
})

describe("selectedCandidateValue", () => {
  it("reads whichever of the two ids the binding carries", () => {
    expect(selectedCandidateValue({ integrationAccountId: "iacc_1" })).toBe("iacc_1")
    expect(selectedCandidateValue({ adapterId: "adp_1" })).toBe("adp_1")
  })

  it("is undefined for an unbound slot", () => {
    expect(selectedCandidateValue(undefined)).toBeUndefined()
    expect(selectedCandidateValue({})).toBeUndefined()
  })
})

describe("bindingForCandidate", () => {
  it("writes exactly one id, never an auth session", () => {
    expect(
      bindingForCandidate({
        value: "iacc_1",
        kind: "integration-account",
        label: "x",
        disabled: false,
      })
    ).toEqual({ integrationAccountId: "iacc_1" })
    expect(
      bindingForCandidate({ value: "adp_1", kind: "adapter", label: "x", disabled: false })
    ).toEqual({ adapterId: "adp_1" })
  })
})
