/** @jest-environment jsdom */
/**
 * The attribution rules are the security surface: the WRONG initiator makes an
 * approval button tappable by the wrong person, and a missing one must fall
 * back to operators rather than to "anyone".
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { approvalActorScope, resolveWorkflowTriggerOrigin } from "./trigger-origin"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

async function seedSession(id: string, binding?: Record<string, unknown>) {
  await getDb().sessions.put({
    id,
    title: "s",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...(binding ? { platformBinding: binding } : {}),
  } as never)
}

async function seedJob(over: Record<string, unknown>) {
  await getDb().connectorInboundJobs.put({
    id: `job_${Math.round(Number(over.receivedAt) || 0)}`,
    conversationKey: "conv-1",
    status: "running",
    receivedAt: 1,
    event: { sender: { id: "pid", remoteUserId: "u1", displayName: "Ann" } },
    ...over,
  } as never)
}

describe("resolveWorkflowTriggerOrigin", () => {
  it("is null without a session id — an editor-started run has no remote origin", async () => {
    await expect(resolveWorkflowTriggerOrigin(undefined)).resolves.toBeNull()
  })

  it("is null when the session does not exist", async () => {
    await expect(resolveWorkflowTriggerOrigin("missing")).resolves.toBeNull()
  })

  it("is null when the session is not bound to a conversation", async () => {
    await seedSession("s1")
    await expect(resolveWorkflowTriggerOrigin("s1")).resolves.toBeNull()
  })

  it("carries the binding, with no initiator when no job is running", async () => {
    await seedSession("s1", { adapterId: "slack", conversationKey: "conv-1" })
    await expect(resolveWorkflowTriggerOrigin("s1")).resolves.toEqual({
      source: "im",
      adapterId: "slack",
      conversationKey: "conv-1",
      sessionId: "s1",
    })
  })

  it("attributes to the MOST RECENT running job, not an older finished turn", async () => {
    await seedSession("s1", { adapterId: "slack", conversationKey: "conv-1" })
    await seedJob({
      receivedAt: 1,
      event: { sender: { id: "p1", remoteUserId: "old", displayName: "Old" } },
    })
    await seedJob({
      receivedAt: 9,
      event: { sender: { id: "p2", remoteUserId: "new", displayName: "New" } },
    })
    const origin = await resolveWorkflowTriggerOrigin("s1")
    expect(origin?.initiator).toMatchObject({ remoteUserId: "new", displayName: "New" })
  })

  it("ignores jobs that are not running", async () => {
    await seedSession("s1", { adapterId: "slack", conversationKey: "conv-1" })
    await seedJob({ receivedAt: 5, status: "done" })
    const origin = await resolveWorkflowTriggerOrigin("s1")
    expect(origin?.initiator).toBeUndefined()
  })

  it("stamps principal + account only when BOTH are present", async () => {
    await seedSession("s1", { adapterId: "slack", conversationKey: "conv-1" })
    await seedJob({ receivedAt: 2, principalId: "prin" })
    expect((await resolveWorkflowTriggerOrigin("s1"))?.initiator).not.toHaveProperty("principalId")

    await getDb().connectorInboundJobs.clear()
    await seedJob({ receivedAt: 3, principalId: "prin", accountId: "acct" })
    expect((await resolveWorkflowTriggerOrigin("s1"))?.initiator).toMatchObject({
      principalId: "prin",
      accountId: "acct",
    })
  })
})

describe("approvalActorScope", () => {
  it("scopes to the initiator when there is one", () => {
    expect(
      approvalActorScope({
        source: "im",
        adapterId: "slack",
        conversationKey: "c",
        initiator: { platformIdentityId: "p", remoteUserId: "u1", displayName: "Ann" },
      } as never)
    ).toEqual({ mode: "initiator", allowedUserIds: ["u1"] })
  })

  it("falls back to operators, never to an unscoped approval", () => {
    expect(
      approvalActorScope({ source: "im", adapterId: "slack", conversationKey: "c" } as never)
    ).toEqual({ mode: "operators" })
  })
})
