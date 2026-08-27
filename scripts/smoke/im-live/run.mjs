// The P0 scenario: two turns through a real platform against a real target.
//
// Turn 1 @-mentions the target bot in the shared conversation. Turn 2 replies
// to the bot's OWN message. Those are not two flavours of the same thing —
// `lib/connectors/conversation-admission.ts` admits a group message on either
// `selfMentioned` OR `isReplyToSelf`, so running both proves both admission
// paths rather than the same one twice.
//
// Each turn waits on two independent observations CONCURRENTLY: the model
// fixture's request log, and the conversation itself. Waiting on them in
// sequence would make a 120s budget into a 240s one, and — worse — a run where
// the reply never arrives could never observe that the fixture was bypassed.

import { STATUS, diagnoseTurn } from "./diagnose.mjs"
import { collectRepliesForWindow, waitForMarkedReply } from "./drivers/observe.mjs"
import { buildMarker } from "./marker.mjs"

/**
 * One turn.
 *
 * `send` posts the probe; everything after it is identical for both turns.
 * Returns every observation plus the verdict — the caller decides whether the
 * run continues.
 */
export async function runTurn({
  driver,
  lease,
  fixture,
  marker,
  send,
  turnTimeoutMs,
  duplicateWindowMs,
  signal,
  now = Date.now,
  sleepImpl,
}) {
  const observedBefore = lease.observed.length
  const probe = await send()

  const [fixtureHit] = await Promise.all([
    fixture.waitForMarker(marker, { timeoutMs: turnTimeoutMs, signal }),
    waitForMarkedReply(driver, lease, { marker, timeoutMs: turnTimeoutMs, signal, now, sleepImpl }),
  ])

  // Always burn the duplicate window when something replied: a second delivery
  // typically lands a beat after the first, and returning at the first reply is
  // exactly how exactly-once violations go unnoticed.
  if (lease.observed.length > observedBefore) {
    await collectRepliesForWindow(driver, lease, {
      windowMs: duplicateWindowMs,
      signal,
      now,
      sleepImpl,
    })
  }

  const replies = lease.observed.slice(observedBefore)
  return { probe, fixtureHit, replies, diagnosis: diagnoseTurn({ fixtureHit, replies, marker }) }
}

/**
 * Both turns, the lock, cleanup and the report.
 *
 * `lock` and `report` are passed in already created so the caller owns their
 * lifetime — a failed run must still write its evidence and release its lock.
 */
export async function runPlatform({
  driver,
  fixture,
  report,
  runId,
  platform,
  turnTimeoutMs,
  duplicateWindowMs,
  cleanup: shouldCleanup,
  signal,
  now = Date.now,
  sleepImpl,
  runDoctor = true,
}) {
  if (runDoctor) {
    const endDoctor = report.phase("doctor")
    const checks = await driver.doctor()
    const failed = checks.filter((check) => !check.ok)
    endDoctor(failed.length === 0 ? "ok" : "failed")
    if (failed.length > 0) {
      return report.finish(
        STATUS.DOCTOR_FAILED,
        failed.map((check) => `${check.name}: ${check.detail}`).join(" | ")
      )
    }
  }

  // Clear the fixture BEFORE preparing the conversation: a request captured
  // from an earlier run could otherwise satisfy this run's marker wait.
  const endReset = report.phase("fixture-reset")
  await fixture.reset()
  endReset()

  let status = STATUS.PASS
  let lastReply = null
  let lease = null
  try {
    // Inside the block that owns cleanup, not before it. No driver posts
    // anything from `prepare` today — they only take a read cursor — but the
    // surface allows it, and a `prepare` that creates something and then
    // throws would otherwise leave it in the operator's real conversation
    // with nothing in the report naming it.
    const endPrepare = report.phase("prepare")
    lease = await driver.prepare()
    endPrepare()

    for (const turn of [1, 2]) {
      const marker = buildMarker(platform, runId, turn)
      const endTurn = report.phase(`turn-${turn}`)
      const result = await runTurn({
        driver,
        lease,
        fixture,
        marker,
        turnTimeoutMs,
        duplicateWindowMs,
        signal,
        now,
        sleepImpl,
        send: () =>
          turn === 1
            ? driver.injectMention(lease, marker)
            : driver.replyToTarget(lease, lastReply, marker),
      })
      endTurn(result.diagnosis.status)
      report.recordTurn({ turn, marker, ...result })

      if (result.diagnosis.status !== STATUS.PASS) {
        status = result.diagnosis.status
        break
      }
      // Turn 2 replies to the message turn 1 got back.
      lastReply = result.replies.find((reply) => (reply.text ?? "").includes(marker))
    }
  } finally {
    // Cleanup runs on failure too when the operator asked for it; the evidence
    // that matters (ids, timings, markers) is already in the report.
    if (!lease) {
      // `prepare` never handed one back, so there is nothing to clean up —
      // and saying that beats a cleanup line that implies a pass it never ran.
      report.recordCleanup({ skipped: true, reason: "prepare did not yield a lease" })
    } else if (shouldCleanup) {
      const endCleanup = report.phase("cleanup")
      const result = await driver.cleanup(lease).catch((error) => ({
        deleted: [],
        retained: [{ id: "*", reason: String(error?.message ?? error) }],
        ok: false,
      }))
      report.recordCleanup(result)
      endCleanup(result.ok ? "ok" : "partial")
    } else {
      report.recordCleanup({ skipped: true, reason: "IM_LIVE_KEEP=1" })
    }
  }

  return report.finish(status)
}
