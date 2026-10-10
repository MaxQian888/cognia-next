import { CollabConflictError, type CollabFileSharingPolicy } from "./client"
import {
  forgetOrgFileSharingPolicies,
  getOrgFileSharingPolicy,
  saveOrgFileSharingPolicy,
} from "./file-sharing-policy"

function policy(revision: number, allowPublicSnapshots = true): CollabFileSharingPolicy {
  return {
    allowPublicSnapshots,
    allowLiveGrants: true,
    allowProtocolCredentials: false,
    allowLiveWrite: false,
    allowAgentSharing: false,
    maxSnapshotTtlSeconds: 2_592_000,
    maxLiveTtlSeconds: 604_800,
    revision,
  }
}

function context(overrides: { orgId?: string; localAccountId?: string; baseUrl?: string } = {}) {
  return {
    orgId: overrides.orgId ?? "org_a",
    localAccountId: overrides.localAccountId ?? "acct",
    client: {
      baseUrl: overrides.baseUrl ?? "https://collab.example",
      getFileSharingPolicy: jest.fn(async () => policy(1)),
      putFileSharingPolicy: jest.fn(async (_org: string, input: { baseRevision: number }) =>
        policy(input.baseRevision + 1, false)
      ),
    },
  }
}

beforeEach(() => forgetOrgFileSharingPolicies())

describe("getOrgFileSharingPolicy", () => {
  it("caches per endpoint, account and org", async () => {
    const a = context()
    expect(await getOrgFileSharingPolicy(a)).toEqual(policy(1))
    await getOrgFileSharingPolicy(a)
    expect(a.client.getFileSharingPolicy).toHaveBeenCalledTimes(1)

    for (const other of [
      context({ orgId: "org_b" }),
      context({ localAccountId: "other" }),
      context({ baseUrl: "https://elsewhere.example" }),
    ]) {
      await getOrgFileSharingPolicy(other)
      expect(other.client.getFileSharingPolicy).toHaveBeenCalledTimes(1)
    }
  })

  it("refetches when the server has a newer revision or on request", async () => {
    const a = context()
    await getOrgFileSharingPolicy(a)
    a.client.getFileSharingPolicy.mockResolvedValueOnce(policy(3, false))
    expect(await getOrgFileSharingPolicy(a, { minRevision: 3 })).toEqual(policy(3, false))
    await getOrgFileSharingPolicy(a, { minRevision: 2 })
    expect(a.client.getFileSharingPolicy).toHaveBeenCalledTimes(2)
    await getOrgFileSharingPolicy(a, { refresh: true })
    expect(a.client.getFileSharingPolicy).toHaveBeenCalledTimes(3)
  })
})

describe("saveOrgFileSharingPolicy", () => {
  it("saves over the base revision and caches the result", async () => {
    const a = context()
    const { revision: _revision, ...settings } = policy(0, false)
    const saved = await saveOrgFileSharingPolicy(a, settings, 1)
    expect(saved.revision).toBe(2)
    expect(a.client.putFileSharingPolicy).toHaveBeenCalledWith("org_a", {
      ...settings,
      baseRevision: 1,
    })
    expect(await getOrgFileSharingPolicy(a)).toBe(saved)
    expect(a.client.getFileSharingPolicy).not.toHaveBeenCalled()
  })

  it("drops the cache on a conflict so the next read is fresh", async () => {
    const a = context()
    await getOrgFileSharingPolicy(a)
    a.client.putFileSharingPolicy.mockRejectedValueOnce(
      new CollabConflictError("conflict", policy(5))
    )
    const { revision: _revision, ...settings } = policy(0)
    await expect(saveOrgFileSharingPolicy(a, settings, 1)).rejects.toBeInstanceOf(
      CollabConflictError
    )
    await getOrgFileSharingPolicy(a)
    expect(a.client.getFileSharingPolicy).toHaveBeenCalledTimes(2)
  })
})
