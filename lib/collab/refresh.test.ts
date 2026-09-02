/** @jest-environment jsdom */

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { listCollabIssues } from "@/lib/db/collab-issue-mirror"
import { listWorkspaceRoster, resolvePersonStanding } from "@/lib/db/identity"
import { listCollabWorkspaces } from "@/lib/db/collab-workspace-mirror"
import { listCollabPlans } from "@/lib/db/collab-plan-mirror"
import { listCollabRuns } from "@/lib/db/collab-run-mirror"
import { saveCollabConnection, forgetCollabConnection } from "./connection"
import { refreshCollabPlane, refreshCollabPlaneQuietly } from "./refresh"
import { readActiveAccessToken } from "@/lib/logto/app-session"

// Every case below injects `accessToken`; this one seam is for the default,
// which must read a token that is good NOW (refreshing if it has to) rather
// than whatever the keyring happens to hold.
jest.mock("@/lib/logto/app-session", () => ({ readActiveAccessToken: jest.fn() }))
const readToken = readActiveAccessToken as jest.Mock

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
    db.collabWorkspaces.clear(),
    db.collabPlans.clear(),
    db.collabRuns.clear(),
    db.orgMemberships.clear(),
    db.workspaceMemberships.clear(),
    db.users.clear(),
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
  workspaces?: unknown[]
  /** Keyed by workspace id. A missing entry answers 403, like a revoked seat. */
  rosters?: Record<string, unknown[]>
  plans?: unknown[]
  runs?: unknown[]
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
    const roster = input.match(/\/workspaces\/([^/]+)\/members$/)
    if (roster) {
      const members = routes.rosters?.[roster[1]!]
      if (!members) return new Response("{}", { status: 403 })
      return jsonResponse(members)
    }
    if (input.endsWith("/workspaces")) {
      return jsonResponse(routes.workspaces ?? [])
    }
    if (input.includes("/plans")) return jsonResponse(routes.plans ?? [])
    if (input.includes("/runs")) return jsonResponse(routes.runs ?? [])
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

describe("refreshCollabPlane — workspaces and their rosters", () => {
  beforeEach(() => {
    saveCollabConnection(ACCOUNT, { baseUrl: "https://collab.example" })
  })

  function workspaceRoutes(rosters: Record<string, unknown[]>): Routes {
    return {
      memberships: {
        userId: ADA,
        orgId: ORG,
        orgRole: "member",
        workspaces: [{ workspaceId: "proj-1", role: "member" }],
      },
      workspaces: [{ id: "proj-1", orgId: ORG, name: "Mercury", createdAt: 1, updatedAt: 2 }],
      rosters,
    }
  }

  it("mirrors the name a guest has no other way to learn", async () => {
    // Somebody invited into a workspace they did not create holds no local
    // `projects` row for it, so without this they see an opaque id.
    const { options } = deps(workspaceRoutes({ "proj-1": [] }))
    await refreshCollabPlane(options)
    expect((await listCollabWorkspaces(ORG)).map((row) => row.name)).toEqual(["Mercury"])
  })

  it("fills a roster that shows more than the caller", async () => {
    // `memberships/me` reports only the caller, so without the roster the
    // projection knows exactly one person per workspace — not a roster.
    const { options } = deps(
      workspaceRoutes({
        "proj-1": [
          { userId: ADA, displayName: "Ada", role: "member", orgMember: true },
          { userId: "usr_cleo", displayName: "Cleo", role: "viewer", orgMember: false },
        ],
      })
    )
    const result = await refreshCollabPlane(options)
    expect(result).toMatchObject({ members: 2 })

    const roster = await listWorkspaceRoster("proj-1")
    expect(roster.map((entry) => [entry.user?.displayName, entry.guest])).toEqual([
      ["Ada", false],
      ["Cleo", true],
    ])
  })

  it("drops somebody the roster no longer lists", async () => {
    const before = deps(
      workspaceRoutes({
        "proj-1": [
          { userId: ADA, displayName: "Ada", role: "member", orgMember: true },
          { userId: "usr_cleo", displayName: "Cleo", role: "viewer", orgMember: false },
        ],
      })
    )
    await refreshCollabPlane(before.options)

    const after = deps(
      workspaceRoutes({
        "proj-1": [{ userId: ADA, displayName: "Ada", role: "member", orgMember: true }],
      })
    )
    await refreshCollabPlane(after.options)
    expect(await listWorkspaceRoster("proj-1")).toHaveLength(1)
  })

  it("keeps the other workspaces when one roster is refused", async () => {
    // Read access can be revoked between the listing and the roster call.
    // Emptying a roster because of that race is the worse answer.
    const seeded = deps(
      workspaceRoutes({
        "proj-1": [{ userId: ADA, displayName: "Ada", role: "member", orgMember: true }],
      })
    )
    await refreshCollabPlane(seeded.options)

    const refused = deps(workspaceRoutes({}))
    const result = await refreshCollabPlane(refused.options)
    expect(result).toMatchObject({ members: 0 })
    // The workspace is still mirrored, and its roster was left alone.
    expect(await listCollabWorkspaces(ORG)).toHaveLength(1)
    expect(await listWorkspaceRoster("proj-1")).toHaveLength(1)
  })
})

describe("refreshCollabPlane — plans and runs (Batch 7c)", () => {
  it("mirrors plan headers and runs, and reports what it stored", async () => {
    saveCollabConnection(ACCOUNT, { baseUrl: "https://collab.example" })
    const { options, calls } = deps({
      memberships: {
        userId: ADA,
        orgId: ORG,
        orgRole: "member",
        workspaces: [{ workspaceId: "proj-1", role: "member" }],
      },
      plans: [
        {
          id: "plan_1",
          orgId: ORG,
          workspaceId: "proj-1",
          title: "Migrate the store",
          status: "executing",
          totalSteps: 3,
          completedSteps: 1,
          createdBy: { kind: "human", id: ADA },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      runs: [
        {
          id: "run_1",
          orgId: ORG,
          workspaceId: "proj-1",
          issueId: "iss_1",
          title: "Fix the flake",
          kind: "agent-task",
          status: "running",
          startedBy: { kind: "human", id: ADA },
          startedAt: 5,
          updatedAt: 5,
          artifacts: [{ label: "PR #12", href: "https://example.com/pr/12" }],
        },
      ],
    })

    const result = await refreshCollabPlane(options)
    expect(result).toMatchObject({ status: "refreshed", plans: 1, runs: 1 })

    // One listing each — NOT one request per plan for its steps.
    expect(calls.filter((url) => url.includes("/plans")).length).toBe(1)
    expect(calls.filter((url) => url.includes("/runs")).length).toBe(1)

    const [plan] = await listCollabPlans({ orgId: ORG })
    expect(plan).toMatchObject({ id: "plan_1", totalSteps: 3, completedSteps: 1, fetchedAt: 1_000 })
    // Headers only: a step list nothing renders is not worth a request per plan.
    expect(plan).not.toHaveProperty("steps")

    const [run] = await listCollabRuns({ orgId: ORG })
    expect(run).toMatchObject({ id: "run_1", kind: "agent-task", status: "running" })
    expect(run?.artifacts).toEqual([{ label: "PR #12", href: "https://example.com/pr/12" }])
  })

  it("files nothing another org's server answered with", async () => {
    // Same defence the issue pull takes: a wrong answer must not be stored
    // under the org that was asked.
    saveCollabConnection(ACCOUNT, { baseUrl: "https://collab.example" })
    const { options } = deps({
      memberships: { userId: ADA, orgId: ORG, orgRole: "member", workspaces: [] },
      plans: [
        {
          id: "plan_elsewhere",
          orgId: "org_somewhere_else",
          workspaceId: "proj-9",
          title: "Not ours",
          status: "draft",
          totalSteps: 0,
          completedSteps: 0,
          createdBy: { kind: "human", id: ADA },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    expect(await refreshCollabPlane(options)).toMatchObject({ plans: 0 })
    expect(await listCollabPlans()).toEqual([])
  })

  it("defaults a run with no artifacts key to an empty list", async () => {
    // The wire field is `#[serde(default)]`; an undefined array here would
    // break every `.map` the panel does.
    saveCollabConnection(ACCOUNT, { baseUrl: "https://collab.example" })
    const { options } = deps({
      memberships: { userId: ADA, orgId: ORG, orgRole: "member", workspaces: [] },
      runs: [
        {
          id: "run_bare",
          orgId: ORG,
          workspaceId: "proj-1",
          title: "Ad-hoc sweep",
          kind: "agent-task",
          status: "queued",
          startedBy: { kind: "human", id: ADA },
          startedAt: 5,
          updatedAt: 5,
        },
      ],
    })

    await refreshCollabPlane(options)
    const [run] = await listCollabRuns({ orgId: ORG })
    expect(run?.artifacts).toEqual([])
    expect(run?.issueId).toBeUndefined()
  })
})

describe("the default token source", () => {
  it("reads an active (refreshed) token for the profile, never the raw keyring blob", async () => {
    saveCollabConnection(ACCOUNT, { baseUrl: "https://collab.example" })
    readToken.mockResolvedValue("fresh-token")
    const { calls, impl } = fetchReturning({})
    const result = await refreshCollabPlane({
      localAccountId: ACCOUNT,
      registry: registryReturning({ localAccountId: ACCOUNT, orgId: ORG }),
      fetchImpl: impl,
      now: () => 1_000,
    })
    expect(result.status).toBe("refreshed")
    expect(readToken).toHaveBeenCalledWith(ACCOUNT)
    expect(calls.some((url) => url.endsWith("/grants"))).toBe(true)
  })
})
