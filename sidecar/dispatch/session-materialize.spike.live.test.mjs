// R1 spike (ADR-0090 Phase 8): can a canonical session be MATERIALIZED into a
// claude-code session the SDK will natively resume?
//
// This is a live probe of the REAL SDK + claude-code CLI (same harness as the
// other *.live.test.mjs), kept in the suite as an SDK-upgrade tripwire. Its
// three findings freeze the claude-code codec's `materialize` fidelity:
//
//   1. PUBLIC SURFACE — the SDK exports session MANAGEMENT (list/get/fork/
//      delete/import-to-store) but NO create-from-external-messages API, so
//      there is no public path to materialize a foreign transcript as a
//      native session. Verdict: `materialize` fidelity = "contextual"
//      (replay-prompt), NOT "native-exact". If an SDK upgrade adds such an
//      API, the surface assertion below fails and the verdict must be
//      revisited.
//   2. FOREIGN-ID RESUME — resuming a session id the SDK never created must
//      NOT silently succeed as if context existed. Pinned shape: the turn
//      either errors, or starts over as a FRESH session (different SDK id).
//   3. NO FABRICATED JSONL — the invariant "never forge Claude's private
//      JSONL" is tested, not hoped: after the foreign-resume attempt, no
//      transcript file named after the foreign id exists anywhere under
//      CLAUDE_CONFIG_DIR.
//
// The SDK's OWN resume round-trip (create → resume by returned id) is covered
// by multiturn.live.test.mjs and deliberately not duplicated here.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { startMockAnthropic, spawnSidecar } from "./live-harness.mjs"

/** Recursively list files under dir (missing dir ⇒ empty). */
function listFilesRecursive(dir) {
  let out = []
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = path.join(dir, entry)
    try {
      if (statSync(p).isDirectory()) out = out.concat(listFilesRecursive(p))
      else out.push(p)
    } catch {
      // raced deletion — ignore
    }
  }
  return out
}

test("R1 spike: SDK public surface has session management but NO external materialize API", async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  const exported = Object.keys(sdk)

  // The management surface the recovery planner MAY use (read/list/fork).
  for (const fn of [
    "query",
    "listSessions",
    "getSessionInfo",
    "getSessionMessages",
    "forkSession",
    "deleteSession",
    "importSessionToStore",
  ]) {
    assert.ok(exported.includes(fn), `expected public SDK export "${fn}"`)
  }

  // TRIPWIRE: no public create-from-external-content API today. If one of
  // these ever appears, the claude-code codec's `materialize` verdict
  // ("contextual", replay-prompt based) must be re-evaluated toward
  // structured/native-exact.
  const materializeShaped = exported.filter((name) =>
    /^(create|write|append|put|materialize).*(session|messages|transcript)/i.test(name)
  )
  assert.deepEqual(
    materializeShaped,
    [],
    `SDK grew a possible materialize API (${materializeShaped.join(", ")}) — revisit the R1 verdict`
  )
})

test("R1 spike: foreign-id resume never silently succeeds, and no JSONL is forged for it", async () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "cognia-r1-config-"))
  const FOREIGN_ID = "11111111-2222-4333-8444-555566667777"

  const mock = startMockAnthropic({ chunks: ["spike-reply"] })
  await mock.listen()
  const sidecar = spawnSidecar({
    baseUrl: mock.baseUrl,
    extraEnv: { CLAUDE_CONFIG_DIR: configDir },
  })

  try {
    await sidecar.waitFor((m) => m.type === "ready", { timeoutMs: 15_000, label: "ready" })

    // Attempt to resume a session the SDK NEVER created.
    sidecar.send({
      type: "send",
      sessionId: "r1-foreign",
      prompt: "Continue where we left off.",
      options: { resume: FOREIGN_ID },
    })

    // Pinned failure shape: either the turn errors, or it starts OVER as a
    // fresh session (the SDK mints a different id). Both are honest; what is
    // forbidden is "resumed successfully with the foreign id as if context
    // existed".
    const outcome = await sidecar.waitFor(
      (m) =>
        (m.type === "event" && m.event?.type === "result") ||
        m.type === "error" ||
        m.type === "sdk_session_id",
      { timeoutMs: 30_000, label: "foreign-resume outcome" }
    )

    if (outcome.type === "sdk_session_id") {
      assert.notEqual(
        outcome.sdkSessionId,
        FOREIGN_ID,
        "SDK must not adopt a foreign session id as its own resumable session"
      )
    } else if (outcome.type === "event") {
      // A result frame for a failed resume must not be a silent success that
      // claims the foreign id.
      const errored = outcome.event.is_error === true || outcome.event.subtype !== "success"
      const adoptedForeign = outcome.event.session_id === FOREIGN_ID
      assert.ok(
        errored || !adoptedForeign,
        `foreign-id resume produced a non-error result claiming the foreign id: ${JSON.stringify(
          outcome.event
        ).slice(0, 400)}`
      )
    }
    // outcome.type === "error" is a valid pinned failure shape by itself.

    // INVARIANT (tested, not hoped): nothing — not the sidecar, not this
    // spike — fabricated a private transcript for the foreign id.
    const files = listFilesRecursive(configDir)
    const forged = files.filter((f) => f.includes(FOREIGN_ID))
    assert.deepEqual(forged, [], `forged transcript files for the foreign id: ${forged.join(", ")}`)
  } finally {
    await sidecar.close()
    await mock.close()
  }
})
