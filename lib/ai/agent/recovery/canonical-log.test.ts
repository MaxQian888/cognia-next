/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import {
  CanonicalLogCorruptionError,
  __resetCanonicalLogForTesting,
  appendCanonicalEnvelopes,
  projectCanonicalHeader,
  pruneCanonicalEnvelopeDetails,
  readCanonicalEnvelopes,
} from "./canonical-log"
import { appendEvent, listRunEvents } from "@/lib/workflow/runtime/event-log"
import { mapWorkflowRunEvent } from "@/lib/execution/sources/workflow"
import { __resetDbForTesting } from "@/lib/db/schema"
import { getDb } from "@/lib/db/schema"

function envelope(sequence: number, attemptId = "a1"): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `s1:${attemptId}:${sequence}`,
    sequence,
    sessionId: "s1",
    runId: "run-x",
    turnId: "t1",
    attemptId,
    hostRef: "desktop-sidecar",
    runtime: "claude-agent-sdk",
    timestamp: `2026-07-24T00:00:0${sequence}.000Z`,
    event: {
      kind: "text-delta",
      delta: `chunk-${sequence}`,
    },
  }
}

beforeEach(async () => {
  await __resetDbForTesting()
  __resetCanonicalLogForTesting()
})

describe("canonical envelope log", () => {
  it("appends and reads back the stream in order on the EXISTING event log", async () => {
    const wrote = await appendCanonicalEnvelopes("run-a", [envelope(0), envelope(1), envelope(2)])
    expect(wrote).toBe(3)
    const read = await readCanonicalEnvelopes("run-a")
    expect(read.map((e) => e.eventId)).toEqual(["s1:a1:0", "s1:a1:1", "s1:a1:2"])
  })

  it("is idempotent on envelope identity across cache resets", async () => {
    await appendCanonicalEnvelopes("run-b", [envelope(0), envelope(1)])
    expect(await appendCanonicalEnvelopes("run-b", [envelope(0), envelope(1)])).toBe(0)
    // Cold cache (fresh process): the persisted rows still dedupe the replay.
    __resetCanonicalLogForTesting()
    expect(await appendCanonicalEnvelopes("run-b", [envelope(1), envelope(2)])).toBe(1)
    expect((await readCanonicalEnvelopes("run-b")).map((e) => e.sequence)).toEqual([0, 1, 2])
  })

  it("keeps legacy envelopes whose reused event id belongs to another turn", async () => {
    const first = envelope(0)
    const second = { ...envelope(0), turnId: "t2" }

    expect(await appendCanonicalEnvelopes("run-legacy-collision", [first])).toBe(1)
    __resetCanonicalLogForTesting()
    expect(await appendCanonicalEnvelopes("run-legacy-collision", [second])).toBe(1)
    expect(
      (await readCanonicalEnvelopes("run-legacy-collision")).map((item) => item.turnId)
    ).toEqual(["t1", "t2"])
  })

  it("serializes concurrent appends so duplicate ids remain exactly once", async () => {
    const first = envelope(0)
    const second = envelope(1)

    const [a, b] = await Promise.all([
      appendCanonicalEnvelopes("run-concurrent", [first, second]),
      appendCanonicalEnvelopes("run-concurrent", [first, second]),
    ])

    expect(a + b).toBe(2)
    expect(await readCanonicalEnvelopes("run-concurrent")).toHaveLength(2)
  })

  it("coexists with ordinary workflow events and stays OUT of the semantic journal", async () => {
    await appendEvent({ runId: "run-c", type: "run_started" })
    await appendCanonicalEnvelopes("run-c", [envelope(0)])
    await appendEvent({ runId: "run-c", type: "run_completed" })

    const rows = await listRunEvents("run-c")
    expect(rows).toHaveLength(3)
    // The envelope row maps to null in the journal mapper (run_log is dropped),
    // so envelope frames never pollute the run timeline.
    const envelopeRow = rows.find((r) => r.type === "run_log")!
    expect(mapWorkflowRunEvent(envelopeRow)).toBeNull()
    // And reading envelopes ignores the ordinary events.
    expect(await readCanonicalEnvelopes("run-c")).toHaveLength(1)
  })

  it("fails closed when an agent-envelope log row is corrupted", async () => {
    await appendEvent({
      runId: "run-corrupt",
      type: "run_log",
      payload: { kind: "agent_envelope", envelope: { eventId: 42 } },
    })
    await expect(readCanonicalEnvelopes("run-corrupt")).rejects.toThrow(
      "canonical agent envelope log is corrupt"
    )
  })

  it("rejects an eventId-only envelope as canonical-log corruption", async () => {
    await appendEvent({
      runId: "run-event-id-only",
      type: "run_log",
      payload: { kind: "agent_envelope", envelope: { eventId: "partial" } },
    })
    await expect(readCanonicalEnvelopes("run-event-id-only")).rejects.toBeInstanceOf(
      CanonicalLogCorruptionError
    )
  })

  it("projects the session header (counts, per-attempt sequences, time range)", async () => {
    await appendCanonicalEnvelopes("run-d", [
      envelope(0, "a1"),
      envelope(1, "a1"),
      envelope(0, "a2"),
    ])
    const header = projectCanonicalHeader("run-d", await readCanonicalEnvelopes("run-d"))
    expect(header).toEqual({
      runId: "run-d",
      sessionId: "s1",
      eventCount: 3,
      lastSequenceByAttempt: { "s1:t1:a1": 1, "s1:t1:a2": 0 },
      firstTimestamp: "2026-07-24T00:00:00.000Z",
      lastTimestamp: "2026-07-24T00:00:00.000Z",
    })
  })

  it("projects an empty stream without optional fields", async () => {
    const header = projectCanonicalHeader("run-e", [])
    expect(header).toEqual({ runId: "run-e", eventCount: 0, lastSequenceByAttempt: {} })
  })

  it("prunes only canonical detail older than the 30-day retention window", async () => {
    await appendCanonicalEnvelopes("run-old", [envelope(0)])
    await appendEvent({ runId: "run-old", type: "run_started" })
    const rows = await listRunEvents("run-old")
    await getDb().workflowRunEvents.update(rows[0].id, { ts: 1 })
    await getDb().workflowRunEvents.update(rows[1].id, { ts: 1 })

    expect(await pruneCanonicalEnvelopeDetails(31 * 24 * 60 * 60 * 1000)).toBe(1)
    const remaining = await listRunEvents("run-old")
    expect(remaining).toHaveLength(1)
    expect(remaining[0].type).toBe("run_started")
  })
})
