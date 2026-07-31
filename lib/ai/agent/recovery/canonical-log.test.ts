/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import {
  __resetCanonicalLogForTesting,
  appendCanonicalEnvelopes,
  projectCanonicalHeader,
  readCanonicalEnvelopes,
} from "./canonical-log"
import { appendEvent, listRunEvents } from "@/lib/workflow/runtime/event-log"
import { mapWorkflowRunEvent } from "@/lib/execution/sources/workflow"
import { __resetDbForTesting } from "@/lib/db/schema"

function envelope(sequence: number, attemptId = "a1"): AgentEventEnvelope {
  return {
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
      type: "text_delta",
      text: `chunk-${sequence}`,
    } as unknown as AgentEventEnvelope["event"],
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

  it("is idempotent on eventId — replays write nothing, across cache resets too", async () => {
    await appendCanonicalEnvelopes("run-b", [envelope(0), envelope(1)])
    expect(await appendCanonicalEnvelopes("run-b", [envelope(0), envelope(1)])).toBe(0)
    // Cold cache (fresh process): the persisted rows still dedupe the replay.
    __resetCanonicalLogForTesting()
    expect(await appendCanonicalEnvelopes("run-b", [envelope(1), envelope(2)])).toBe(1)
    expect((await readCanonicalEnvelopes("run-b")).map((e) => e.sequence)).toEqual([0, 1, 2])
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
      lastSequenceByAttempt: { a1: 1, a2: 0 },
      firstTimestamp: "2026-07-24T00:00:00.000Z",
      lastTimestamp: "2026-07-24T00:00:00.000Z",
    })
  })

  it("projects an empty stream without optional fields", async () => {
    const header = projectCanonicalHeader("run-e", [])
    expect(header).toEqual({ runId: "run-e", eventCount: 0, lastSequenceByAttempt: {} })
  })
})
