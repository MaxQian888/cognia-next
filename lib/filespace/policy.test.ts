import type { CollabFileSharingPolicy } from "@/lib/collab/client"

import {
  DEFAULT_FILE_SHARING_POLICY,
  FILE_SHARING_MAX_TTL_SECONDS,
  FILE_SHARING_MIN_TTL_SECONDS,
  FILE_SHARING_TTL_PRESETS_SECONDS,
  checkSnapshotFileShare,
  editFileSharingPolicy,
  intersectFileSharingPolicies,
  loadEffectiveFileSharingPolicy,
  resolveLocalFileSharingPolicy,
  type EffectivePolicyDeps,
} from "./policy"

jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/collab/runtime-client", () => ({ resolveCurrentCollabContext: jest.fn() }))

const ORG: CollabFileSharingPolicy = {
  allowPublicSnapshots: true,
  allowLiveGrants: false,
  allowProtocolCredentials: true,
  allowLiveWrite: true,
  allowAgentSharing: true,
  maxSnapshotTtlSeconds: 86_400,
  maxLiveTtlSeconds: 30 * 86_400,
  revision: 4,
}

describe("resolveLocalFileSharingPolicy", () => {
  it("fills absent fields with the conservative defaults", () => {
    expect(resolveLocalFileSharingPolicy(undefined)).toEqual(DEFAULT_FILE_SHARING_POLICY)
    expect(DEFAULT_FILE_SHARING_POLICY).toMatchObject({
      allowProtocolCredentials: false,
      allowLiveWrite: false,
      allowAgentSharing: false,
    })
  })

  it("clamps ceilings and ignores values of the wrong type", () => {
    const policy = resolveLocalFileSharingPolicy({
      maxSnapshotTtlSeconds: 5,
      maxLiveTtlSeconds: Number.POSITIVE_INFINITY,
      allowPublicSnapshots: "no" as never,
    })
    expect(policy.maxSnapshotTtlSeconds).toBe(FILE_SHARING_MIN_TTL_SECONDS)
    expect(policy.maxLiveTtlSeconds).toBe(DEFAULT_FILE_SHARING_POLICY.maxLiveTtlSeconds)
    expect(policy.allowPublicSnapshots).toBe(true)
    expect(resolveLocalFileSharingPolicy({ maxLiveTtlSeconds: 10 ** 12 }).maxLiveTtlSeconds).toBe(
      FILE_SHARING_MAX_TTL_SECONDS
    )
  })

  it("turns live write and credentials off with live access", () => {
    const policy = resolveLocalFileSharingPolicy({
      allowLiveGrants: false,
      allowLiveWrite: true,
      allowProtocolCredentials: true,
    })
    expect(policy).toMatchObject({ allowLiveWrite: false, allowProtocolCredentials: false })
  })
})

describe("intersectFileSharingPolicies", () => {
  it("keeps a switch on only when both allow it and takes the lower ceiling", () => {
    const local = resolveLocalFileSharingPolicy({
      allowLiveWrite: true,
      allowProtocolCredentials: true,
      allowAgentSharing: false,
    })
    expect(intersectFileSharingPolicies(local, ORG)).toEqual({
      allowPublicSnapshots: true,
      allowLiveGrants: false,
      allowProtocolCredentials: true,
      allowLiveWrite: true,
      allowAgentSharing: false,
      maxSnapshotTtlSeconds: 86_400,
      maxLiveTtlSeconds: local.maxLiveTtlSeconds,
    })
  })

  it("is the local policy alone without an org", () => {
    const local = resolveLocalFileSharingPolicy({})
    expect(intersectFileSharingPolicies(local, null)).toBe(local)
  })
})

describe("checkSnapshotFileShare", () => {
  const policy = intersectFileSharingPolicies(resolveLocalFileSharingPolicy({}), ORG)

  it("allows a lifetime within the ceiling", () => {
    expect(checkSnapshotFileShare(policy, 3600)).toBeNull()
    expect(checkSnapshotFileShare(policy, 86_400)).toBeNull()
  })

  it("refuses a longer or open-ended lifetime, and a policy without snapshots", () => {
    expect(checkSnapshotFileShare(policy, 86_401)).toBe("ttl-exceeds-policy")
    expect(checkSnapshotFileShare(policy, undefined)).toBe("ttl-exceeds-policy")
    expect(checkSnapshotFileShare({ ...policy, allowPublicSnapshots: false }, 60)).toBe(
      "public-snapshots-disabled"
    )
  })
})

describe("loadEffectiveFileSharingPolicy", () => {
  const context = { orgId: "org_a", localAccountId: "acct", userId: "u", client: {} } as never

  function deps(overrides: Partial<EffectivePolicyDeps> = {}): EffectivePolicyDeps {
    return {
      readSettings: async () => ({ fileSharing: { allowAgentSharing: true } }),
      resolveCollabContext: async () => null,
      readOrgPolicy: jest.fn(async () => ORG),
      ...overrides,
    }
  }

  it("is the local policy for an account without an org", async () => {
    const d = deps()
    const effective = await loadEffectiveFileSharingPolicy({}, d)
    expect(effective.policy.allowAgentSharing).toBe(true)
    expect(effective.org).toBeUndefined()
    expect(d.readOrgPolicy).not.toHaveBeenCalled()
  })

  it("intersects with the org policy and passes the revision hint on", async () => {
    const d = deps({ resolveCollabContext: async () => context })
    const effective = await loadEffectiveFileSharingPolicy({ minOrgRevision: 4 }, d)
    expect(d.readOrgPolicy).toHaveBeenCalledWith(context, { minRevision: 4, refresh: undefined })
    expect(effective.org).toEqual({ orgId: "org_a", policy: ORG })
    expect(effective.policy.allowLiveGrants).toBe(false)
    expect(effective.policy.maxSnapshotTtlSeconds).toBe(86_400)
  })

  it("refuses what the org could forbid when its policy cannot be read", async () => {
    const effective = await loadEffectiveFileSharingPolicy(
      {},
      deps({
        resolveCollabContext: async () => context,
        readOrgPolicy: jest.fn(async () => {
          throw new Error("offline")
        }),
      })
    )
    expect(effective.orgUnavailable).toBe(true)
    expect(effective.policy.allowPublicSnapshots).toBe(false)
    expect(effective.policy.allowAgentSharing).toBe(false)
  })

  it("treats a failing collaboration lookup like an unreadable org policy", async () => {
    const effective = await loadEffectiveFileSharingPolicy(
      {},
      deps({
        resolveCollabContext: async () => {
          throw new Error("keyring locked")
        },
      })
    )
    expect(effective.org).toBeUndefined()
    expect(effective.orgUnavailable).toBe(true)
    expect(effective.policy.allowPublicSnapshots).toBe(false)
  })
})

describe("editFileSharingPolicy", () => {
  it("turns live write and network credentials off with live access", () => {
    const open = {
      ...DEFAULT_FILE_SHARING_POLICY,
      allowProtocolCredentials: true,
      allowLiveWrite: true,
    }
    expect(editFileSharingPolicy(open, { allowLiveGrants: false })).toMatchObject({
      allowLiveGrants: false,
      allowProtocolCredentials: false,
      allowLiveWrite: false,
    })
  })

  it("turns live access on when something that needs it is turned on", () => {
    const closed = { ...DEFAULT_FILE_SHARING_POLICY, allowLiveGrants: false }
    expect(editFileSharingPolicy(closed, { allowLiveWrite: true }).allowLiveGrants).toBe(true)
    expect(editFileSharingPolicy(closed, { allowProtocolCredentials: true }).allowLiveGrants).toBe(
      true
    )
  })

  it("leaves unrelated fields as edited", () => {
    expect(
      editFileSharingPolicy(DEFAULT_FILE_SHARING_POLICY, { maxSnapshotTtlSeconds: 3600 })
    ).toEqual({ ...DEFAULT_FILE_SHARING_POLICY, maxSnapshotTtlSeconds: 3600 })
  })
})

describe("FILE_SHARING_TTL_PRESETS_SECONDS", () => {
  it("is ascending, within the bounds, and offers both defaults", () => {
    const presets = [...FILE_SHARING_TTL_PRESETS_SECONDS]
    expect(presets).toEqual([...presets].sort((a, b) => a - b))
    expect(presets[0]).toBe(FILE_SHARING_MIN_TTL_SECONDS)
    expect(presets.at(-1)).toBe(FILE_SHARING_MAX_TTL_SECONDS)
    expect(presets).toContain(DEFAULT_FILE_SHARING_POLICY.maxSnapshotTtlSeconds)
    expect(presets).toContain(DEFAULT_FILE_SHARING_POLICY.maxLiveTtlSeconds)
  })
})
