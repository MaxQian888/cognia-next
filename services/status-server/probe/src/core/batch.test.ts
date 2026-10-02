import { describe, expect, it } from "vitest"

import { parseObservationBatch } from "../../../../../lib/status/validate"
import { buildObservationBatch, newRunId } from "./batch"
import type { ProbeRunResult } from "./types"

const SCHEDULED = Date.UTC(2026, 9, 2, 10, 0, 0)

const passing: ProbeRunResult = {
  startedAtMs: SCHEDULED + 120,
  finishedAtMs: SCHEDULED + 1_840,
  checks: [
    {
      checkId: "signalingHttp",
      result: "pass",
      durationMs: 85,
      reason: null,
      attempted: true,
      dependsOn: null,
    },
    {
      checkId: "signalingAuth",
      result: "pass",
      durationMs: 1_200,
      reason: null,
      attempted: true,
      dependsOn: null,
    },
    {
      checkId: "relayData",
      result: "pass",
      durationMs: 210,
      reason: null,
      attempted: true,
      dependsOn: null,
    },
  ],
}

describe("buildObservationBatch", () => {
  it("produces a body the ingestion parser accepts", () => {
    const batch = buildObservationBatch({
      probeId: "ext-fra-1",
      runId: newRunId(SCHEDULED),
      registryRevision: 3,
      scheduledAtMs: SCHEDULED,
      profileId: "native",
      result: passing,
      extraChecks: [
        {
          checkId: "statusPage",
          result: "pass",
          durationMs: 40,
          reason: null,
          attempted: true,
          dependsOn: null,
        },
        {
          checkId: "statusApi",
          result: "fail",
          durationMs: 6_000,
          reason: "timeout",
          attempted: true,
          dependsOn: null,
        },
      ],
    })
    expect(parseObservationBatch(batch)).toEqual({ ok: true, value: batch })
    expect(batch).toMatchObject({
      schemaVersion: 1,
      scheduledAt: "2026-10-02T10:00:00.000Z",
      startedAt: "2026-10-02T10:00:00.120Z",
      finishedAt: "2026-10-02T10:00:01.840Z",
      profileId: "native",
    })
    expect(batch.checks.map((check) => check.checkId)).toEqual([
      "signalingHttp",
      "signalingAuth",
      "relayData",
      "statusPage",
      "statusApi",
    ])
  })

  it("accepts dependency gaps and runner errors", () => {
    const batch = buildObservationBatch({
      probeId: "ext-fra-1",
      runId: "r1",
      registryRevision: 0,
      scheduledAtMs: SCHEDULED,
      profileId: "ios",
      result: {
        startedAtMs: SCHEDULED,
        finishedAtMs: SCHEDULED,
        checks: [
          {
            checkId: "signalingAuth",
            result: "fail",
            durationMs: 403,
            reason: "origin_rejected",
            attempted: true,
            dependsOn: null,
          },
          {
            checkId: "relayData",
            result: "unknown",
            durationMs: null,
            reason: "dependency_failed",
            attempted: false,
            dependsOn: "signalingAuth",
          },
        ],
      },
    })
    expect(parseObservationBatch(batch).ok).toBe(true)
  })

  it("never emits finishedAt before startedAt", () => {
    const batch = buildObservationBatch({
      probeId: "p",
      runId: "r",
      registryRevision: 1,
      scheduledAtMs: SCHEDULED,
      profileId: "native",
      result: { ...passing, finishedAtMs: passing.startedAtMs - 5 },
    })
    expect(batch.finishedAt).toBe(batch.startedAt)
  })

  it("throws instead of producing an invalid body", () => {
    expect(() =>
      buildObservationBatch({
        probeId: "bad id with spaces",
        runId: "r",
        registryRevision: 1,
        scheduledAtMs: SCHEDULED,
        profileId: "native",
        result: passing,
      })
    ).toThrow(/invalid observation batch/)
    expect(() =>
      buildObservationBatch({
        probeId: "p",
        runId: "r",
        registryRevision: 1,
        scheduledAtMs: SCHEDULED,
        profileId: "native",
        result: { ...passing, checks: [] },
      })
    ).toThrow(/invalid observation batch/)
  })
})

describe("newRunId", () => {
  it("matches the opaque-id pattern and never repeats", () => {
    const ids = new Set<string>()
    for (let index = 0; index < 500; index += 1) {
      const id = newRunId(SCHEDULED)
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      ids.add(id)
    }
    expect(ids.size).toBe(500)
    expect(newRunId(-5)).toMatch(/^r0-/)
  })
})
