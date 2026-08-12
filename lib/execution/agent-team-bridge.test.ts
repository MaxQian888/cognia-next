import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AgentTeamRunRecord } from "@/types/agent/agent-team-runtime"
import {
  agentTeamExecutionRunId,
  ensureAgentTeamExecutionRun,
  projectRemoteAgentTeamEvent,
  settleAgentTeamExecutionRun,
} from "./agent-team-bridge"

const sourceRun: AgentTeamRunRecord = {
  id: "team-run-1",
  teamId: "team-1",
  projectId: "project-1",
  objective: "Ship remote dispatch",
  status: "running",
  priority: 1,
  decisionVersion: 0,
  createdAt: 100,
  startedAt: 110,
  updatedAt: 110,
}

describe("AgentTeam ExecutionRun bridge", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("creates one canonical team run and deduplicates replayed remote events", async () => {
    await ensureAgentTeamExecutionRun(sourceRun)
    await projectRemoteAgentTeamEvent({
      sourceRun,
      childRunId: "child-1",
      taskId: "task-1",
      hostRef: "device:worker-a",
      envelope: {
        eventId: "remote-1",
        sequence: 1,
        event: { kind: "tool-call", toolName: "read_file", input: { secret: "not stored" } },
      },
      ts: 120,
    })
    await projectRemoteAgentTeamEvent({
      sourceRun,
      childRunId: "child-1",
      taskId: "task-1",
      hostRef: "device:worker-a",
      envelope: {
        eventId: "remote-1",
        sequence: 1,
        event: { kind: "tool-call", toolName: "read_file", input: { secret: "not stored" } },
      },
      ts: 120,
    })

    const runId = agentTeamExecutionRunId(sourceRun.id)
    const events = (await getDb().executionRunEvents.where("runId").equals(runId).toArray()).sort(
      (left, right) => left.seq - right.seq
    )
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: "tool.started",
      sourceEventId: "agent-team:team-run-1:remote:remote-1",
      payload: {
        childRunId: "child-1",
        hostRef: "device:worker-a",
        toolName: "read_file",
      },
    })
    expect(JSON.stringify(events)).not.toContain("not stored")
  })

  it("settles the same ExecutionRun instead of creating another authority", async () => {
    await settleAgentTeamExecutionRun(sourceRun, "completed", 200)
    const rows = await getDb().executionRuns.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "execution:team:team-run-1",
      sourceId: "team-run-1",
      status: "completed",
    })
  })
})
