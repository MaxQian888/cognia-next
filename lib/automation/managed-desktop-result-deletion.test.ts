import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { useAccountStore } from "@/stores/account/account-store"
import { localTransport } from "@/lib/tauri/transport-instance"
import { createSession, deleteSession } from "@/lib/db/sessions"
import {
  isManagedDesktopResultDeletionPending,
  prepareManagedDesktopSessionDeletion,
  retryManagedDesktopResultDeletions,
  listPendingManagedDesktopResultDeletions,
  MANAGED_DESKTOP_RUN_PREFIX,
  deleteManagedDesktopAcceptance,
} from "./managed-desktop-result-deletion"

jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => null,
  getActiveRemoteEndpoint: () => null,
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: jest.fn() },
  transport: { call: jest.fn() },
  onTransportChange: () => () => undefined,
}))
jest.mock("@/lib/utils", () => ({ ...jest.requireActual("@/lib/utils"), isTauri: () => true }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: () => () => undefined },
}))
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
const commands: string[] = []
function online(cleanupPending = false, hostId = "host-a", taskIds: string[] = []) {
  jest.mocked(localTransport.call).mockImplementation(async (_name, input) => {
    if (_name === "external_agent_delete_gateway_task") {
      commands.push(_name)
      return undefined as never
    }
    const { name, args } = input as { name: string; args: { operationId: string } }
    commands.push(name)
    if (name === "managed_desktop_handoff_source_host") return { hostId } as never
    return {
      operationId: args.operationId,
      state: name.endsWith("abort_delete")
        ? "aborted"
        : name.endsWith("commit_delete")
          ? "committed"
          : "prepared",
      cleanupPending,
      taskIds,
    } as never
  })
}
beforeEach(async () => {
  await fixture.restore()
  commands.length = 0
  jest
    .mocked(useAccountStore.getState)
    .mockReturnValue({ unlockedAccountId: "owner", locked: false } as never)
  online()
})
async function source() {
  const row = await createSession({ title: "Source" })
  await getDb().sessions.update(row.id, {
    deliverySourceHosts: [{ kind: "local", hostId: "host-a" }],
  })
  return (await getDb().sessions.get(row.id))!
}
it("commits the outbox with canonical deletion then fences native evidence before source revocation", async () => {
  const row = await source()
  online(true)
  await deleteSession(row.id)
  expect(await getDb().sessions.get(row.id)).toBeUndefined()
  const queued = await listPendingManagedDesktopResultDeletions()
  expect(queued).toHaveLength(1)
  expect(queued[0].phase).toBe("committed")
  expect(commands).toContain("managed_desktop_handoff_revoke_source")
  expect(localTransport.call).toHaveBeenCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_handoff_source_host",
    args: {},
  })
  expect(await isManagedDesktopResultDeletionPending(getDb(), { conversationId: row.id })).toBe(
    true
  )
  online()
  await expect(retryManagedDesktopResultDeletions()).resolves.toBe(1)
  expect(commands.indexOf("managed_desktop_results_commit_delete")).toBeLessThan(
    commands.indexOf("managed_desktop_handoff_revoke_source")
  )
  expect(await getDb().managedDesktopDeletionOutbox.count()).toBe(0)
})
it("offline cleanup survives reopen and retention until an acknowledged retry", async () => {
  const row = await source()
  jest.mocked(localTransport.call).mockRejectedValue(new Error("offline sensitive response"))
  await deleteSession(row.id)
  getDb().close()
  await getDb().open()
  const report = { blocked: 0, failed: 0 }
  expect(await retryManagedDesktopResultDeletions(report)).toBe(0)
  expect(report).toEqual({ blocked: 0, failed: 1 })
  const queued = await listPendingManagedDesktopResultDeletions()
  expect(queued).toHaveLength(1)
  expect(JSON.stringify(queued)).not.toContain("sensitive")
  online()
  expect(await retryManagedDesktopResultDeletions()).toBe(1)
})
it("a rolled-back database cascade aborts the provisional freeze without committing evidence deletion", async () => {
  const row = await source()
  const removal = jest
    .spyOn(getDb().sessions, "delete")
    .mockRejectedValueOnce(new Error("disk transaction failure"))
  await expect(deleteSession(row.id)).rejects.toThrow("disk transaction failure")
  removal.mockRestore()
  expect(await getDb().sessions.get(row.id)).toBeDefined()
  expect(commands).toContain("managed_desktop_results_abort_delete")
  expect(commands).not.toContain("managed_desktop_results_commit_delete")
  expect(await getDb().managedDesktopDeletionOutbox.count()).toBe(0)
})
it("replays an abandoned prepare as abort even when its acknowledgment was lost", async () => {
  const row = await source()
  const bridge = await prepareManagedDesktopSessionDeletion(getDb(), [row])
  jest.mocked(localTransport.call).mockRejectedValue(new Error("lost acknowledgment"))
  await bridge.finish(false)
  expect((await listPendingManagedDesktopResultDeletions())[0].phase).toBe("preparing")
  online()
  await retryManagedDesktopResultDeletions()
  expect(commands).toContain("managed_desktop_results_abort_delete")
  expect(commands).not.toContain("managed_desktop_results_commit_delete")
})
it("serializes the sweeper behind an active deletion transaction", async () => {
  const row = await source()
  const bridge = await prepareManagedDesktopSessionDeletion(getDb(), [row])
  const sweep = retryManagedDesktopResultDeletions()
  await Promise.resolve()
  expect(commands).not.toContain("managed_desktop_results_abort_delete")
  await bridge.finish(false)
  await sweep
})
it("removes only acceptance projections, including their events, bindings and summaries", async () => {
  const row = await source()
  const acceptanceId = `${MANAGED_DESKTOP_RUN_PREFIX}acceptance`
  await getDb().executionRuns.bulkPut(
    [acceptanceId, "unrelated-code-run"].map((id) => ({
      id,
      sessionId: row.id,
      kind: "agent",
      sourceId: "task",
      title: "run",
      status: "completed",
      currentRevision: 1,
      startedAt: 1,
      updatedAt: 2,
    })) as never
  )
  await getDb().executionRunEvents.put({ id: "event", runId: acceptanceId, seq: 1 } as never)
  await getDb().executionRunBindings.put({ id: "binding", runId: acceptanceId } as never)
  await getDb().runResultSummaries.put({ id: "summary", runId: acceptanceId, revision: 1 } as never)
  await deleteSession(row.id)
  expect(await getDb().executionRuns.get(acceptanceId)).toBeUndefined()
  expect(await getDb().executionRuns.get("unrelated-code-run")).toBeDefined()
  expect(await getDb().executionRunEvents.get("event")).toBeUndefined()
  expect(await getDb().executionRunBindings.get("binding")).toBeUndefined()
  expect(await getDb().runResultSummaries.get("summary")).toBeUndefined()
  expect(await getDb().syncTombstones.get(["executionRuns", acceptanceId])).toBeDefined()
})
it("rejects a different owner and never retargets queued cleanup", async () => {
  const row = await source()
  online(true)
  await deleteSession(row.id)
  jest
    .mocked(useAccountStore.getState)
    .mockReturnValue({ unlockedAccountId: "other", locked: false } as never)
  expect(await listPendingManagedDesktopResultDeletions()).toEqual([])
  expect(await retryManagedDesktopResultDeletions()).toBe(0)
  expect(await getDb().managedDesktopDeletionOutbox.count()).toBe(1)
})

it("a handoff-locked conversation refuses before any evidence freeze or outbox write", async () => {
  const row = await source()
  await getDb().sessions.update(row.id, {
    handoffLock: { ticketId: "ticket", state: "frozen", at: 1 },
  })
  await expect(deleteSession(row.id)).rejects.toMatchObject({ code: "session_handoff_locked" })
  expect(commands).toEqual([])
  expect(await getDb().managedDesktopDeletionOutbox.count()).toBe(0)
})
it("new source Host admission during prepare rolls back the database cascade", async () => {
  const row = await source()
  const ordinaryCall = jest.mocked(localTransport.call).getMockImplementation()!
  jest.mocked(localTransport.call).mockImplementation(async (name, input) => {
    if ((input as { name: string }).name === "managed_desktop_results_prepare_delete") {
      await getDb().sessions.update(row.id, {
        deliverySourceHosts: [
          { kind: "local", hostId: "host-a" },
          { kind: "local", hostId: "host-new" },
        ],
      })
    }
    return ordinaryCall(name, input)
  })
  await expect(deleteSession(row.id)).rejects.toThrow("managed_desktop_deletion_scope_changed")
  expect(await getDb().sessions.get(row.id)).toBeDefined()
  expect(commands).not.toContain("managed_desktop_results_commit_delete")
})

it("acceptance-only deletion preserves its parent and keeps a durable fence after physical cleanup", async () => {
  const row = await source()
  const runId = `${MANAGED_DESKTOP_RUN_PREFIX}one`
  await getDb().executionRuns.put({
    id: runId,
    sessionId: row.id,
    sourceId: "task",
    managedDesktopHostId: "host-a",
  } as never)
  await deleteManagedDesktopAcceptance("one", row.id, {
    db: getDb(),
    assertActive: () => undefined,
  })
  expect(await getDb().sessions.get(row.id)).toBeDefined()
  expect(await getDb().executionRuns.get(runId)).toBeUndefined()
  expect(await listPendingManagedDesktopResultDeletions()).toEqual([])
  expect(await isManagedDesktopResultDeletionPending(getDb(), { acceptanceId: "one" })).toBe(true)
  expect(await isManagedDesktopResultDeletionPending(getDb(), { conversationId: row.id })).toBe(
    false
  )
  expect((await getDb().managedDesktopDeletionOutbox.toArray())[0].phase).toBe("deleted")
  expect(commands).not.toContain("managed_desktop_handoff_revoke_source")
  expect(await retryManagedDesktopResultDeletions()).toBe(0)
})
it("acceptance deletion refuses a guessed source Host before preparing native cleanup", async () => {
  const row = await source()
  await getDb().executionRuns.put({
    id: `${MANAGED_DESKTOP_RUN_PREFIX}one`,
    sessionId: row.id,
    sourceId: "task",
    managedDesktopHostId: "foreign",
  } as never)
  await expect(
    deleteManagedDesktopAcceptance("one", row.id, { db: getDb(), assertActive: () => undefined })
  ).rejects.toThrow("original_host_required")
  expect(commands).toEqual([])
})

it("pins queued gateway cleanup to the verified original transport after committed evidence deletion", async () => {
  const row = await source()
  await getDb().sessions.update(row.id, {
    externalAgentSession: { agentId: "agent", sessionId: "cognia-gateway:task-one:native-session" },
  } as never)
  online(false, "host-a", ["task-one"])
  await deleteSession(row.id)
  expect(localTransport.call).toHaveBeenCalledWith("external_agent_delete_gateway_task", {
    taskId: "task-one",
  })
  expect(commands.indexOf("managed_desktop_results_commit_delete")).toBeLessThan(
    commands.indexOf("external_agent_delete_gateway_task")
  )
  expect(await listPendingManagedDesktopResultDeletions()).toEqual([])
})
it("uses Host-derived tasks only, ignoring unscoped or foreign renderer gateway links", async () => {
  const row = await source()
  await getDb().sessions.update(row.id, {
    externalAgentSession: { agentId: "agent", sessionId: "unscoped-session" },
  } as never)
  await deleteSession(row.id)
  expect(await getDb().sessions.get(row.id)).toBeUndefined()
  expect(await listPendingManagedDesktopResultDeletions()).toEqual([])
  expect(commands).not.toContain("external_agent_delete_gateway_task")
})
it("cleans each Host's authoritative tasks without scattering links across two Hosts", async () => {
  const row = await source()
  await getDb().sessions.update(row.id, {
    deliverySourceHosts: [
      { kind: "local", hostId: "host-a" },
      { kind: "local", hostId: "host-b" },
    ],
    externalAgentGatewaySessions: [
      { agentId: "a", sessionId: "cognia-gateway:task-a:native" },
      { agentId: "b", sessionId: "cognia-gateway:task-b:native" },
    ],
  } as never)
  online(false, "host-a", ["task-a"])
  await deleteSession(row.id)
  expect(localTransport.call).toHaveBeenCalledWith("external_agent_delete_gateway_task", {
    taskId: "task-a",
  })
  expect(localTransport.call).not.toHaveBeenCalledWith("external_agent_delete_gateway_task", {
    taskId: "task-b",
  })
  expect(
    (await listPendingManagedDesktopResultDeletions()).map((entry) => entry.host.hostId)
  ).toEqual(["host-b"])
  jest.mocked(localTransport.call).mockClear()
  online(false, "host-b", ["task-b"])
  expect(await retryManagedDesktopResultDeletions()).toBe(1)
  expect(localTransport.call).toHaveBeenCalledWith("external_agent_delete_gateway_task", {
    taskId: "task-b",
  })
  expect(localTransport.call).not.toHaveBeenCalledWith("external_agent_delete_gateway_task", {
    taskId: "task-a",
  })
  expect(await listPendingManagedDesktopResultDeletions()).toEqual([])
})
it("re-reads Host tasks after revocation to include admissions that raced the first commit", async () => {
  const row = await source()
  const ordinary = jest.mocked(localTransport.call).getMockImplementation()!
  let revoked = false
  jest.mocked(localTransport.call).mockImplementation(async (name, input) => {
    const command = (input as { name?: string }).name
    if (command === "managed_desktop_handoff_revoke_source") revoked = true
    const result = await ordinary(name, input)
    if (command === "managed_desktop_results_commit_delete")
      return { ...(result as object), taskIds: revoked ? ["late-task"] : [] } as never
    return result
  })
  await deleteSession(row.id)
  expect(localTransport.call).toHaveBeenCalledWith("external_agent_delete_gateway_task", {
    taskId: "late-task",
  })
  expect(commands.filter((name) => name === "managed_desktop_results_commit_delete")).toHaveLength(
    2
  )
})
