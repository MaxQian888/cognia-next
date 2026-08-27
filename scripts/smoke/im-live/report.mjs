// Evidence file for one platform's run.
//
// The report is written on success AND on failure — a failed run is exactly
// when the ids matter, because the operator has to go find the message in the
// real conversation. What it must never contain is message text: the target
// chat is a real conversation, and this file lands on disk and gets pasted
// into issues. Replies are recorded as an id plus whether they carried this
// run's marker, which is everything an assertion needs and nothing more.

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { FAILING_STATUSES, STATUS } from "./diagnose.mjs"

export { STATUS }

export function createRunReport({ platform, runId, now = Date.now }) {
  const startedAt = now()
  const phases = []
  const turns = []
  let cleanup = null
  let status = null
  let finishedAt = null
  let lock = null

  return {
    platform,
    runId,

    /** Time one stage. Returns the ender so the caller cannot forget the name. */
    phase(name) {
      const from = now()
      return (outcome = "ok") => {
        phases.push({ name, ms: now() - from, outcome })
      }
    },

    recordLock({ file, stoleFrom }) {
      lock = { file, stoleFrom: stoleFrom ?? null }
    },

    /**
     * One conversational turn.
     *
     * `replies` come in with text so the marker can be checked here; only the
     * derived facts are kept.
     */
    recordTurn({ turn, marker, probe, fixtureHit, replies = [], diagnosis }) {
      turns.push({
        turn,
        marker,
        probeMessageId: probe?.messageId ?? null,
        sentAt: probe?.sentAt ?? null,
        fixture: fixtureHit
          ? {
              hit: true,
              model: fixtureHit.model,
              stream: fixtureHit.stream,
              markers: fixtureHit.markers,
            }
          : { hit: false },
        replies: replies.map((reply) => ({
          messageId: reply.messageId ?? null,
          at: reply.at ?? null,
          threadId: reply.threadId ?? null,
          matchedMarker: (reply.text ?? "").includes(marker),
        })),
        status: diagnosis.status,
        summary: diagnosis.summary,
        markerReplyCount: diagnosis.markerReplyCount,
        extraReplyCount: diagnosis.extraReplyCount,
        causes: diagnosis.causes,
      })
    },

    recordCleanup(result) {
      cleanup = result
    },

    finish(nextStatus, error) {
      status = nextStatus
      finishedAt = now()
      if (error) this.error = error
      return this.toJSON()
    },

    toJSON() {
      return {
        schema: "cognia.im-live.run/1",
        platform,
        runId,
        status: status ?? STATUS.FAIL,
        startedAt,
        finishedAt: finishedAt ?? now(),
        durationMs: (finishedAt ?? now()) - startedAt,
        lock,
        phases,
        turns,
        cleanup,
        ...(this.error ? { error: this.error } : {}),
      }
    },
  }
}

/** True when this status must make the process exit non-zero. */
export function isFailing(status) {
  return FAILING_STATUSES.includes(status)
}

/**
 * Persist one run's evidence under `<outputDir>/<runId>/<platform>.json`.
 *
 * Everything is passed through the redactor immediately before serialization,
 * so a credential that reached a field by accident still cannot land on disk.
 */
export async function writeRunReport({ outputDir, report, redactor, fs = { mkdir, writeFile } }) {
  const payload = typeof report.toJSON === "function" ? report.toJSON() : report
  const dir = path.join(outputDir, payload.runId)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${payload.platform}.json`)
  const safe = redactor ? redactor.redact(payload) : payload
  await fs.writeFile(file, `${JSON.stringify(safe, null, 2)}\n`, "utf8")
  return file
}

/** One line per platform for the end-of-run summary. */
export function summarize(results) {
  const counts = {}
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1
  const order = [
    STATUS.PASS,
    STATUS.FAIL,
    STATUS.TIMEOUT,
    STATUS.MODEL_NOT_INTERCEPTED,
    STATUS.DOCTOR_FAILED,
    STATUS.NOT_CONFIGURED,
  ]
  const parts = order.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`)
  return {
    counts,
    line: parts.join(", ") || "nothing ran",
    exitCode: results.some((result) => isFailing(result.status)) ? 1 : 0,
  }
}
