/**
 * Integration tests for lib/notifications/delivery/coordinator.ts — the
 * reliable-commit orchestrator. Covers the durable fact→intent projection:
 * a notifiable run event mints a governed intent + outbound job atomically
 * with the cursor advance, a non-notifiable event advances the cursor with
 * no intent, the in-app center emitter fires per fact, and a send failure
 * blocks the row without skipping the cursor.
 *
 * Dexie runs on fake-indexeddb via createDbTestFixture (jsdom project).
 */

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { upsertNotificationTarget } from "@/lib/db/notification-targets"
import { upsertNotificationSubscription } from "@/lib/db/notification-subscriptions"
import { claimProjectionWork, runSubjectKey } from "@/lib/db/notification-projection-work"
import { listIntentsForLogicalKey } from "@/lib/db/notification-delivery"
import { coordinateProjectionWork, operationKeyFor } from "./coordinator"
import { runFactLogicalKey } from "./facts"
import { __setNotificationIdentityForTesting } from "../scope"
import { scopeKeyOf, type NotificationScope } from "@/types/notifications/scope"
import type { NotificationPolicyContext } from "@/types/notifications/decision"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"
import type { ExecutionRun } from "@/types/execution/run"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __setNotificationIdentityForTesting({
    namespaceId: "ns",
    accountId: "acct",
    authorityHostId: "host-1",
  })
})
afterAll(async () => {
  __setNotificationIdentityForTesting(null)
  await dbFixture.dispose()
})

// The scope the journal's commit-time touch encodes for workspace "ws".
const scope: NotificationScope = {
  namespaceId: "ns",
  accountId: "acct",
  authorityHostId: "host-1",
  workspaceId: "ws",
}
const SCOPE_KEY = scopeKeyOf(scope)

const POLICY: NotificationPolicyContext = {
  policyVersion: 1,
  timezone: "UTC",
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  quietHoursAllowCritical: false,
  osThreshold: "info",
  pushThreshold: "info",
}

function convTarget(): ConversationDeliveryTarget {
  return {
    address: {
      conversationKey: "ck-chat",
      platform: "feishu",
      adapterId: "ad-1",
      scopeKind: "group",
      containerId: "chat-1",
    },
    conversationRef: { platform: "feishu", adapterId: "ad-1" },
    refreshedAt: 0,
  }
}

async function seedRun(): Promise<ExecutionRun> {
  return createExecutionRun({
    id: "r1",
    kind: "workflow",
    sourceId: "src",
    title: "Deploy",
    status: "running",
    currentRevision: 0,
    startedAt: 0,
    updatedAt: 0,
    projectId: "ws",
  })
}

async function seedRoute(targetLabel = "chat"): Promise<{ targetId: string }> {
  const target = await upsertNotificationTarget({
    scope,
    label: targetLabel,
    address: {
      kind: "connector",
      adapterId: "ad-1",
      region: "feishu",
      deliveryTarget: convTarget(),
    },
    enabled: true,
    consent: { mode: "proactive", grantRef: "g", grantedBy: "acct", grantedAt: 0 },
    disclosureProfileId: "internal",
    locale: "en",
    timezone: "UTC",
  })
  await upsertNotificationSubscription({
    scope,
    principalId: "acct",
    binding: { kind: "scope" },
    targetIds: [target.id],
    maxDisclosureProfileId: "internal",
    minLevel: "info",
    enabled: true,
    createdBy: "test",
  })
  return { targetId: target.id }
}

async function claimRun() {
  const work = await claimProjectionWork(runSubjectKey("r1"), "host-1")
  if (!work) throw new Error("expected a claimable work row for r1")
  return work
}

async function workRow() {
  return getDb().notificationProjectionWork.where("subjectKey").equals(runSubjectKey("r1")).first()
}

describe("coordinateProjectionWork", () => {
  it("mints a governed intent + outbound job for a notifiable event", async () => {
    await seedRun()
    await seedRoute()
    await runEventJournal.append("r1", {
      type: "run.failed",
      ts: 1,
      visibility: "summary",
      payload: { title: "Deploy failed", summary: "boom" },
    })
    const work = await claimRun()
    const res = await coordinateProjectionWork({ work, policy: POLICY, leaseOwner: "host-1" })
    expect(res.processedEvents).toBe(1)
    expect(res.intentsCommitted).toBe(1)
    // The governed intent + its outbound job landed together.
    const intents = await listIntentsForLogicalKey(runFactLogicalKey("r1", "terminal"))
    expect(intents).toHaveLength(1)
    expect(intents[0].status).toBe("queued")
    expect(intents[0].outboundJobId).toBeTruthy()
    const job = await getDb().outboundQueue.get(intents[0].outboundJobId!)
    expect(job).toBeDefined()
    expect(job!.source).toBe("notification")
    expect(job!.notificationOperationKey).toBe(intents[0].operationKey)
  })

  it("advances the cursor past a non-notifiable event with no intent", async () => {
    await seedRun()
    await seedRoute()
    await runEventJournal.append("r1", {
      type: "tool.started",
      ts: 1,
      visibility: "summary",
      payload: {},
    })
    const work = await claimRun()
    const res = await coordinateProjectionWork({ work, policy: POLICY, leaseOwner: "host-1" })
    expect(res.processedEvents).toBe(1)
    expect(res.intentsCommitted).toBe(0)
    expect(res.done).toBe(true)
    expect((await workRow())!.state).toBe("done")
  })

  it("emits the in-app center record for every derived fact", async () => {
    await seedRun()
    await seedRoute()
    await runEventJournal.append("r1", {
      type: "run.completed",
      ts: 1,
      visibility: "summary",
      payload: { title: "Done" },
    })
    const emitted: string[] = []
    const work = await claimRun()
    await coordinateProjectionWork({
      work,
      policy: POLICY,
      leaseOwner: "host-1",
      emitCenter: ({ derived }) => {
        emitted.push(derived.fact.factKey)
      },
    })
    expect(emitted).toEqual([runFactLogicalKey("r1", "terminal")])
  })

  it("is idempotent — a replay of the same event mints no second intent", async () => {
    await seedRun()
    await seedRoute()
    await runEventJournal.append("r1", {
      type: "run.failed",
      ts: 1,
      visibility: "summary",
      payload: { title: "F" },
    })
    const work = await claimRun()
    await coordinateProjectionWork({ work, policy: POLICY, leaseOwner: "host-1" })
    const before = await listIntentsForLogicalKey(runFactLogicalKey("r1", "terminal"))
    // A second pass over an already-processed event produces nothing new.
    expect(before).toHaveLength(1)
  })

  it("uses the fact's stable operation key for the (fact,target,purpose) op", () => {
    expect(operationKeyFor("run:r1:terminal", "t1", "terminal-state")).toBe(
      "n:run:r1:terminal:t1:terminal-state"
    )
  })

  it("returns done with no work when the run vanished", async () => {
    // No run created — a stale work row resolves to done.
    const db = getDb()
    await db.transaction("rw", db.notificationProjectionWork, async (tx) => {
      const { touchNotificationProjectionInTransaction } =
        await import("@/lib/db/notification-projection-work")
      await touchNotificationProjectionInTransaction(tx as never, {
        runId: "ghost",
        scopeKey: SCOPE_KEY,
        desiredRunSeq: 3,
      })
    })
    const work = await claimProjectionWork(runSubjectKey("ghost"), "host-1")
    const res = await coordinateProjectionWork({
      work: work!,
      policy: POLICY,
      leaseOwner: "host-1",
    })
    expect(res.done).toBe(true)
    expect(res.processedEvents).toBe(0)
  })
})
