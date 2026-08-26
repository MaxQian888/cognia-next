/** @jest-environment jsdom */

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { listCollabIssues } from "@/lib/db/collab-issue-mirror"
import { resolvePersonStanding } from "@/lib/db/identity"
import { saveCollabConnection, forgetCollabConnection } from "./connection"
import { refreshCollabPlane, refreshCollabPlaneQuietly } from "./refresh"

const dbFixture = createDbTestFixture()

const ACCOUNT = "acct_a"
const ORG = "org_acme"
const ADA = "usr_ada"

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  const db = getDb()
  await Promise.all([
    db.collabIssues.clear(),
    db.orgMemberships.clear(),
    db.workspaceMemberships.clear(),
  ])
  forgetCollabConnection(ACCOUNT)
})
afterAll(dbFixture.dispose)

/** A binding registry that answers without a database. */
function registryReturning(binding: unknown) {
  return { get: async () => binding } as never
}

interface Routes {
  memberships?: unknown
  issues?: unknown[]
}

/** jsdom's `Response` has no static `json`, so build the body by hand. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function fetchReturning(routes: Routes) {
  const calls: string[] = []
  const impl = async (input: string): Promise<Response> => {
    calls.push(input)
    if (input.endsWith("/grants")) {
      return jsonResponse({
        grant: "g",
        userId: ADA,
        orgId: ORG,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      })
    }
    if (input.includes("/memberships/me")) {
      return jsonResponse(routes.memberships ?? { userId: ADA, orgId: ORG, workspaces: [] })
    }
    return jsonResponse(routes.issues ?? [])
  }
  return { calls, impl }
}

function deps(routes: Routes, binding: unknown = { localAccountId: ACCOUNT, orgId: ORG }) {
  const { calls, impl } = fetchReturning(routes)
  return {
    calls,
    options: {
      localAccountId: ACCOUNT,
      registry: registryReturning(binding),
      fetchImpl: impl,
      accessToken: async () => "logto-token",
      now: () => 1_000,
    },
  }
}

describe("refreshCollabPlane — the states that are not errors", () => {
  it("skips a profile with no collaboration server", async () => {
    const { options, calls } = deps({})
    expect(await refreshCollabPlane(options)).toEqual({
      status: "skipped",
      reason: "not-configured",
    })
    // And asks nothing. A profile that is not set up must not hit the network.
    expect(calls).toEqual([])
  })

  it("skips a profile nobody has signed in on", async () => {
    saveCollabConnection(ACCOUNT, { baseUrl: "https://collab.example" })
    const { options } = deps({}, null)
    expect(await refreshCollabPlane(options)).toEqual({
      status: "skipped",
      reason: "not-signed-in",
    })
  })

  it("skips a person whose binding names no org", async () => {
    saveCollabConnection(ACCOUNT, { baseUrl: "https://collab.example" })
    const { options } = deps({}, { localAccountId: ACCOUNT })
    expect(await refreshCollabPlane(options)).toEqual({ status: "skipped", reason: "no-org" })
  })
})

describe("refreshCollabPlane — a configured, signed-in profile", () => {
  beforeEach(() => {
    saveCollabConnection(ACCOUNT, { baseUrl: "https://collab.example" })
  })

  it("fills both the membership projection and the issue mirror", async () => {
    const { options } = deps({
      memberships: {
        userId: ADA,
        orgId: ORG,
        orgRole: "member",
        workspaces: [{ workspaceId: "proj-1", role: "maintainer" }],
      },
      issues: [
        {
          id: "iss_1",
          orgId: ORG,
          workspaceId: "proj-1",
          issueProjectId: "cont-1",
          title: "Ship it",
          status: "todo",
          priority: "medium",
          boardOrder: 1,
          createdBy: { kind: "human", id: ADA },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })

    const result = await refreshCollabPlane(options)
    expect(result).toMatchObject({
      status: "refreshed",
      orgId: ORG,
      userId: ADA,
      issues: 1,
      workspaces: 1,
      orgMember: true,
    })
    expect(await listCollabIssues({ orgId: ORG })).toHaveLength(1)
    expect(await resolvePersonStanding(ADA)).toBe("org-member")
  })

  /**
   * The whole point of ADR-0149 §4, and the thing Batch 5 could describe but
   * nothing could reach: workspace membership without org membership.
   */
  it("lands a guest", async () => {
    const { options } = deps({
      memberships: {
        userId: ADA,
        orgId: ORG,
        workspaces: [{ workspaceId: "proj-1", role: "viewer" }],
      },
    })

    await refreshCollabPlane(options)
    expect(await resolvePersonStanding(ADA)).toBe("guest")
  })

  it("stops calling somebody an org member once the server stops saying so", async () => {
    const member = deps({
      memberships: { userId: ADA, orgId: ORG, orgRole: "member", workspaces: [] },
    })
    await refreshCollabPlane(member.options)
    expect(await resolvePersonStanding(ADA)).toBe("org-member")

    // Removed from the org, kept in a workspace. A stale membership row would
    // keep reading as "org-member" forever.
    const guest = deps({
      memberships: {
        userId: ADA,
        orgId: ORG,
        workspaces: [{ workspaceId: "proj-1", role: "viewer" }],
      },
    })
    await refreshCollabPlane(guest.options)
    expect(await resolvePersonStanding(ADA)).toBe("guest")
  })

  it("drops a workspace the server no longer lists", async () => {
    const before = deps({
      memberships: {
        userId: ADA,
        orgId: ORG,
        workspaces: [
          { workspaceId: "proj-1", role: "member" },
          { workspaceId: "proj-2", role: "member" },
        ],
      },
    })
    await refreshCollabPlane(before.options)

    const after = deps({
      memberships: {
        userId: ADA,
        orgId: ORG,
        workspaces: [{ workspaceId: "proj-1", role: "member" }],
      },
    })
    expect(await refreshCollabPlane(after.options)).toMatchObject({ workspaces: 1 })
    expect(await getDb().workspaceMemberships.count()).toBe(1)
  })

  it("refuses an answer about a different org rather than filing it here", async () => {
    const { options } = deps({
      memberships: { userId: ADA, orgId: "org_somewhere_else", workspaces: [] },
    })
    await expect(refreshCollabPlane(options)).rejects.toThrow(/answered for/)
  })

  it("pulls memberships before issues", async () => {
    // Who you are decides what you may see of the board, so refreshing the
    // rows before the standing that explains them shows a wrong badge.
    const { options, calls } = deps({ memberships: { userId: ADA, orgId: ORG, workspaces: [] } })
    await refreshCollabPlane(options)
    const membershipCall = calls.findIndex((url) => url.includes("/memberships/me"))
    const issuesCall = calls.findIndex((url) => url.includes("/issues"))
    expect(membershipCall).toBeGreaterThanOrEqual(0)
    expect(issuesCall).toBeGreaterThan(membershipCall)
  })
})

describe("refreshCollabPlaneQuietly", () => {
  it("swallows a failure so a boot path is never blocked by it", async () => {
    saveCollabConnection(ACCOUNT, { baseUrl: "https://collab.example" })
    const options = {
      localAccountId: ACCOUNT,
      registry: registryReturning({ localAccountId: ACCOUNT, orgId: ORG }) as never,
      fetchImpl: async () => {
        throw new Error("network down")
      },
      accessToken: async () => "logto-token",
    }
    expect(await refreshCollabPlaneQuietly(options)).toBeNull()
  })
})
