/**
 * Opt-in evidence run (`pnpm test:live`): the real Node transport and the
 * portable core against the public signaling host, for every client-origin
 * profile. Each run uses a fresh throwaway room and keys; nothing is
 * submitted for ingestion. Override the target with COGNIA_PROBE_LIVE_URL.
 */

import { describe, expect, it } from "vitest"

import type { ProfileId } from "../../../../../lib/status/contract"
import { parseObservationBatch } from "../../../../../lib/status/validate"
import { buildObservationBatch, newRunId, runProbeChecks } from "../core"
import { createNodeTransport } from "./transport"

const SIGNALING_URL = process.env.COGNIA_PROBE_LIVE_URL ?? "wss://signaling.cognia.cn/signaling"

/** The exact Origins the production signaling allowlist admits (plus native). */
const PROFILES: Array<{ id: ProfileId; origin: string | null }> = [
  { id: "native", origin: null },
  { id: "web", origin: "https://cognia.cn" },
  { id: "ios", origin: "capacitor://localhost" },
  { id: "android", origin: "https://localhost" },
]

describe(`live public probe against ${SIGNALING_URL}`, () => {
  for (const profile of PROFILES) {
    it(`${profile.id} profile passes HTTP, signed auth + signal and explicit data lane`, async () => {
      const transport = createNodeTransport({ userAgent: "cognia-status-probe/live-test" })
      const result = await runProbeChecks({
        signalingUrl: SIGNALING_URL,
        profile,
        runHttp: true,
        runProtocol: true,
        transport,
      })
      const scheduledAtMs = Math.floor(result.startedAtMs / 60_000) * 60_000
      const batch = buildObservationBatch({
        probeId: "live-test",
        runId: newRunId(result.startedAtMs),
        registryRevision: 0,
        scheduledAtMs,
        profileId: profile.id,
        result,
      })
      console.log(
        JSON.stringify({
          profile: profile.id,
          origin: profile.origin,
          startedAt: batch.startedAt,
          finishedAt: batch.finishedAt,
          relayBytesSent: result.relayBytesSent,
          checks: batch.checks,
        })
      )
      expect(parseObservationBatch(batch).ok).toBe(true)
      expect(result.aborted).toBe(false)
      for (const check of batch.checks) {
        expect(check, `${profile.id}/${check.checkId}`).toMatchObject({
          result: "pass",
          reason: null,
        })
      }
    })
  }

  it("classifies a forbidden browser Origin as origin_rejected (data lane a dependency gap)", async () => {
    const result = await runProbeChecks({
      signalingUrl: SIGNALING_URL,
      profile: { id: "web", origin: "https://forbidden-origin.invalid" },
      runHttp: false,
      runProtocol: true,
      transport: createNodeTransport({ userAgent: "cognia-status-probe/live-test" }),
    })
    console.log(JSON.stringify({ profile: "web(forbidden origin)", checks: result.checks }))
    expect(result.checks).toEqual([
      expect.objectContaining({
        checkId: "signalingAuth",
        result: "fail",
        reason: "origin_rejected",
      }),
      {
        checkId: "relayData",
        result: "unknown",
        durationMs: null,
        reason: "dependency_failed",
        attempted: false,
        dependsOn: "signalingAuth",
      },
    ])
  })
})
