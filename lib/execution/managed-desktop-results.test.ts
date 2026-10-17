import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getExecutionRun, listExecutionRunEvents } from "@/lib/db/execution-runs"
import {
  managedDesktopAcceptanceRunId,
  managedDesktopVerificationArtifact,
  syncManagedDesktopAcceptanceResult,
} from "./managed-desktop-results"
import type { ManagedDesktopAcceptanceResult } from "@/lib/automation/managed-desktop-results-client"
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: jest.fn(
    async () => (key: string) => (key === "runTitle" ? "桌面验收" : key)
  ),
}))
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
function result(
  outcome: "passed" | "failed" | "inconclusive" | "cancelled" = "passed"
): ManagedDesktopAcceptanceResult {
  return {
    binding: {
      acceptanceId: "a",
      ownerAccountId: "owner",
      hostId: "host",
      sourceId: "source",
      sessionId: "session",
      taskId: "task",
      parentRunId: "parent",
      originRunRef: "origin",
      deliveryId: "delivery",
      deliveryRevision: 1,
      commit: "a".repeat(40),
      desktopId: "desktop",
      desktopGeneration: 1,
      manifestDigest: "b".repeat(64),
      criteria: [{ id: "c", text: "private criterion", requiredEvidence: false }],
    },
    createdAt: 1,
    artifacts: [],
    agentVerdict: {
      input: {
        idempotencyKey: "verdict",
        principalId: "agent",
        outcome,
        criteria: [{ criterionId: "c", outcome: "passed", artifactIds: [] }],
        summary: "private agent summary",
      },
      recordedAt: 2,
    },
    humanApprovals: [],
    cleanupPending: false,
    evidenceLimitReached: false,
    captureAttempts: 0,
    reservedBytes: 0,
  }
}
const scope = { owner: "owner", assertActive: jest.fn() }
async function source() {
  await getDb().sessions.put({
    id: "session",
    title: "Source",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  } as never)
}
test.each([
  ["passed", "completed"],
  ["failed", "failed"],
  ["inconclusive", "failed"],
  ["cancelled", "cancelled"],
] as const)(
  "projects %s into child %s without touching terminal parent",
  async (outcome, status) => {
    await source()
    const parent = {
      id: "parent",
      kind: "job",
      sourceId: "task",
      title: "Source",
      status: "completed",
      currentRevision: 99,
      startedAt: 0,
      updatedAt: 1,
    }
    await getDb().executionRuns.put(parent as never)
    await syncManagedDesktopAcceptanceResult(result(outcome), scope)
    expect(await getExecutionRun("parent")).toEqual(parent)
    const id = managedDesktopAcceptanceRunId("a")
    expect(await getExecutionRun(id)).toMatchObject({
      status,
      title: "桌面验收",
      parentRunId: "parent",
      sourceId: "task",
      sessionId: "session",
      managedDesktopHostId: "host",
    })
    const events = await listExecutionRunEvents(id)
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "artifact.created",
      `run.${status}`,
    ])
    expect(JSON.stringify(events)).not.toMatch(
      /private criterion|private agent summary|base64|principalId/
    )
    expect((await getExecutionRun(id))?.latestSnapshot?.artifacts[0]).toMatchObject({
      title: "桌面验收",
      detailsRef: "a",
      ...(outcome === "cancelled" ? {} : { kind: "verification" }),
    })
  }
)
test("approval revisions and event pruning never reopen or append to a terminal child", async () => {
  await source()
  const value = result()
  await syncManagedDesktopAcceptanceResult(value, scope)
  const id = managedDesktopAcceptanceRunId("a")
  const initial = await getExecutionRun(id)
  await getDb().executionRunEvents.where("runId").equals(id).delete()
  value.humanApprovals.push({
    revision: 1,
    input: {
      expectedRevision: 0,
      idempotencyKey: "human",
      principalId: "human",
      decision: "rejected",
    },
    recordedAt: 3,
  })
  await syncManagedDesktopAcceptanceResult(value, scope)
  expect(await getExecutionRun(id)).toEqual(initial)
  expect(await listExecutionRunEvents(id)).toEqual([])
})
test("missing source and queued deletion fence stale imports", async () => {
  expect(await syncManagedDesktopAcceptanceResult(result(), scope)).toBe(false)
  await source()
  await getDb().managedDesktopDeletionOutbox.put({
    id: "delete",
    ownerAccountId: "owner",
    host: { kind: "local", hostId: "host" },
    conversationIds: ["session"],
    taskIds: [],
    acceptanceIds: [],
    gatewayLinks: [],
    phase: "preparing",
    createdAt: 1,
    updatedAt: 1,
    attempts: 0,
  })
  expect(await syncManagedDesktopAcceptanceResult(result(), scope)).toBe(false)
  expect(await getExecutionRun(managedDesktopAcceptanceRunId("a"))).toBeUndefined()
})
test("owner mismatch and in-flight identity changes abort projection", async () => {
  await source()
  await expect(
    syncManagedDesktopAcceptanceResult(result(), { ...scope, owner: "other" })
  ).rejects.toThrow("owner_mismatch")
  let calls = 0
  await expect(
    syncManagedDesktopAcceptanceResult(result(), {
      owner: "owner",
      assertActive: () => {
        if (++calls > 2) throw new Error("changed")
      },
    })
  ).rejects.toThrow("changed")
  expect(await getExecutionRun(managedDesktopAcceptanceRunId("a"))).toBeUndefined()
})
test("system cancellation does not invent an agent verification enum", () => {
  const value = result()
  value.agentVerdict = null
  value.systemOutcome = { outcome: "cancelled", reasonCode: "source_deleted", recordedAt: 2 }
  expect(managedDesktopVerificationArtifact(value, "Desktop acceptance")).toMatchObject({
    kind: "generic",
  })
  expect(
    managedDesktopVerificationArtifact(value, "Desktop acceptance")?.verification
  ).toBeUndefined()
})
