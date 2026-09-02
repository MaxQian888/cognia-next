/** @jest-environment jsdom */

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  getOrgMembership,
  getWorkspaceMembership,
  linkExternalIdentity,
  listExternalIdentities,
  putOrgMembership,
  putWorkspaceMembership,
  upsertUser,
} from "@/lib/db/identity"

import { reconcileUserId } from "./reconcile-user-id"

const dbFixture = createDbTestFixture()

const LEGACY = "usr_derived00000000000000"
const CANONICAL = "usr_canonical0000000000000"
const ORG = "org_acme0000000000000000000"

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  const db = getDb()
  await Promise.all([
    db.users.clear(),
    db.orgMemberships.clear(),
    db.workspaceMemberships.clear(),
    db.externalIdentities.clear(),
    db.issues.clear(),
    db.collabIssues.clear(),
    db.collabPlans.clear(),
    db.collabRuns.clear(),
  ])
})
afterAll(dbFixture.dispose)

function registry() {
  return {
    get: jest.fn(),
    reconcileUserId: jest.fn(async () => ({}) as never),
  }
}

async function seedLegacyPerson() {
  await upsertUser({ id: LEGACY, displayName: "Ada", createdAt: 1, updatedAt: 1 })
  await putOrgMembership({ orgId: ORG, userId: LEGACY, role: "member", now: 1 })
  await putWorkspaceMembership({
    workspaceId: "proj-1",
    orgId: ORG,
    userId: LEGACY,
    role: "viewer",
    now: 1,
  })
  await linkExternalIdentity({
    userId: LEGACY,
    provider: "logto",
    subject: "sub",
    tenant: "i",
    now: 1,
  })
  const db = getDb()
  await db.issues.put({
    id: "iss_1",
    identifier: "ACM-1",
    projectId: "proj-1",
    issueProjectId: "ip_1",
    title: "Assigned to the derived id",
    status: "todo",
    statusCategory: "unstarted",
    priority: "none",
    assignee: { kind: "human", id: LEGACY, label: "Ada" },
    assigneeKind: "human",
    assigneeId: LEGACY,
    createdBy: { kind: "human", id: LEGACY },
    labelIds: [],
    createdAt: 1,
    updatedAt: 1,
  } as never)
  await db.issues.put({
    id: "iss_2",
    identifier: "ACM-2",
    projectId: "proj-1",
    issueProjectId: "ip_1",
    title: "Assigned to an agent that happens to share the string",
    status: "todo",
    statusCategory: "unstarted",
    priority: "none",
    assignee: { kind: "agent", id: LEGACY },
    assigneeKind: "agent",
    assigneeId: LEGACY,
    createdBy: { kind: "team", id: LEGACY },
    labelIds: [],
    createdAt: 1,
    updatedAt: 1,
  } as never)
  await db.collabIssues.put({
    id: "ciss_1",
    orgId: ORG,
    workspaceId: "proj-1",
    issueProjectId: "ip_1",
    title: "mirror",
    status: "todo",
    priority: "none",
    boardOrder: 0,
    assignee: { kind: "human", id: LEGACY },
    createdBy: { kind: "human", id: LEGACY },
    createdAt: 1,
    updatedAt: 1,
    fetchedAt: 1,
  } as never)
  await db.collabPlans.put({
    id: "plan_1",
    orgId: ORG,
    workspaceId: "proj-1",
    title: "p",
    status: "draft",
    totalSteps: 0,
    completedSteps: 0,
    createdBy: { kind: "human", id: LEGACY },
    createdAt: 1,
    updatedAt: 1,
    fetchedAt: 1,
  } as never)
  await db.collabRuns.put({
    id: "run_1",
    orgId: ORG,
    workspaceId: "proj-1",
    title: "r",
    kind: "agent-task",
    status: "queued",
    startedBy: { kind: "agent", id: LEGACY },
    startedAt: 1,
    updatedAt: 1,
    artifacts: [],
    fetchedAt: 1,
  } as never)
}

describe("reconcileUserId", () => {
  it("does nothing when the ids already agree", async () => {
    const reg = registry()
    const report = await reconcileUserId(
      { localAccountId: "acct_a", legacyUserId: CANONICAL, canonicalUserId: CANONICAL },
      { registry: reg }
    )
    expect(report.changed).toBe(false)
    expect(reg.reconcileUserId).not.toHaveBeenCalled()
  })

  it("rekeys every proven User column and leaves other actor kinds alone", async () => {
    await seedLegacyPerson()
    const reg = registry()
    const report = await reconcileUserId(
      { localAccountId: "acct_a", legacyUserId: LEGACY, canonicalUserId: CANONICAL, now: 50 },
      { registry: reg }
    )
    expect(report).toMatchObject({
      changed: true,
      users: 1,
      orgMemberships: 1,
      workspaceMemberships: 1,
      externalIdentities: 1,
      issueAssignees: 1,
      issueCreators: 1,
      collabIssues: 1,
      collabPlans: 1,
      collabRuns: 0,
      hostRebound: false,
    })
    const db = getDb()
    expect(await db.users.get(LEGACY)).toBeUndefined()
    expect(await db.users.get(CANONICAL)).toMatchObject({ displayName: "Ada" })
    expect(await getOrgMembership(ORG, LEGACY)).toBeUndefined()
    expect(await getOrgMembership(ORG, CANONICAL)).toMatchObject({ role: "member" })
    expect(await getWorkspaceMembership("proj-1", LEGACY)).toBeUndefined()
    expect(await getWorkspaceMembership("proj-1", CANONICAL)).toMatchObject({ role: "viewer" })
    expect(await listExternalIdentities(LEGACY)).toEqual([])
    expect((await listExternalIdentities(CANONICAL)).map((row) => row.subject)).toEqual(["sub"])

    const human = await db.issues.get("iss_1")
    expect(human?.assigneeId).toBe(CANONICAL)
    expect(human?.assignee).toMatchObject({ kind: "human", id: CANONICAL, label: "Ada" })
    expect(human?.createdBy).toMatchObject({ kind: "human", id: CANONICAL })
    // Same string, different domain: untouched.
    const agent = await db.issues.get("iss_2")
    expect(agent?.assigneeId).toBe(LEGACY)
    expect(agent?.createdBy).toMatchObject({ kind: "team", id: LEGACY })

    expect((await db.collabIssues.get("ciss_1"))?.assignee).toMatchObject({ id: CANONICAL })
    expect((await db.collabPlans.get("plan_1"))?.createdBy).toMatchObject({ id: CANONICAL })
    expect((await db.collabRuns.get("run_1"))?.startedBy).toMatchObject({
      kind: "agent",
      id: LEGACY,
    })

    expect(reg.reconcileUserId).toHaveBeenCalledWith("acct_a", CANONICAL, 50)
  })

  it("never overwrites a membership the server already wrote under the canonical id", async () => {
    await seedLegacyPerson()
    await putOrgMembership({ orgId: ORG, userId: CANONICAL, role: "owner", now: 40 })
    await reconcileUserId(
      { localAccountId: "acct_a", legacyUserId: LEGACY, canonicalUserId: CANONICAL, now: 50 },
      { registry: registry() }
    )
    expect(await getOrgMembership(ORG, CANONICAL)).toMatchObject({ role: "owner" })
    expect(await getOrgMembership(ORG, LEGACY)).toBeUndefined()
  })

  it("re-mirrors the person to the host when a token is available", async () => {
    await seedLegacyPerson()
    const invokeFn = jest.fn(async () => undefined)
    const report = await reconcileUserId(
      {
        localAccountId: "acct_a",
        legacyUserId: LEGACY,
        canonicalUserId: CANONICAL,
        orgId: ORG,
        accessToken: "at",
      },
      { registry: registry(), host: { invokeFn: invokeFn as never, isDesktop: () => true } }
    )
    expect(report.hostRebound).toBe(true)
    expect(invokeFn).toHaveBeenCalledWith("account_bind_person", {
      accessToken: "at",
      userId: CANONICAL,
      orgId: ORG,
    })
  })

  it("reports a host failure without undoing the local rekey", async () => {
    await seedLegacyPerson()
    const onHostMirrorFailed = jest.fn()
    const report = await reconcileUserId(
      {
        localAccountId: "acct_a",
        legacyUserId: LEGACY,
        canonicalUserId: CANONICAL,
        accessToken: "at",
      },
      {
        registry: registry(),
        host: {
          invokeFn: (async () => {
            throw new Error("no store")
          }) as never,
          isDesktop: () => true,
        },
        onHostMirrorFailed,
      }
    )
    expect(report.hostRebound).toBe(false)
    expect(onHostMirrorFailed).toHaveBeenCalledTimes(1)
    expect(await getDb().users.get(CANONICAL)).toBeDefined()
  })
})
