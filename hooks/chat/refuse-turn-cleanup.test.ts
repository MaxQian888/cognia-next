import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A source-level guard, not a behavioural one.
 *
 * The failure this protects against is a *missing* call, and no runtime test
 * can enumerate paths that were never written. What can be checked is that the
 * send path has exactly one way to refuse a turn that is already `streaming` —
 * so a path added tomorrow either goes through it or shows up here.
 */
const SOURCE = readFileSync(join(process.cwd(), "hooks/chat/use-claude-chat-controller.ts"), "utf8")

/** The five steps a refusal owes the session, plus the run finish. */
const STEPS = [
  'store.getState().setSessionStatus(sessionId, "idle")',
  "store.getState().setSessionDiagnostic(sessionId, input.diagnostic)",
  'chatTurnPerformance.finish(sessionId, "failed")',
  "await settleChatTurnForSession(sessionId, {",
  "stopAssemblyHeartbeat()",
  'await finishDirectChatExecutionRun(sessionId, "failed")',
]

function refuseTurnBody(): string {
  const start = SOURCE.indexOf("const refuseTurn = async (input: {")
  expect(start).toBeGreaterThan(-1)
  const end = SOURCE.indexOf("\n      }", SOURCE.indexOf('trackEvent("chat.turn.failed"', start))
  expect(end).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

it("completes every cleanup step in one place", () => {
  const body = refuseTurnBody()
  for (const step of STEPS) {
    expect(body).toContain(step)
  }
})

it("reports the refusal, because these paths used to emit nothing at all", () => {
  expect(refuseTurnBody()).toContain('trackEvent("chat.turn.failed"')
})

it("routes every pre-stream refusal through it", () => {
  // `errorCode:` appears in exactly two shapes: inside `refuseTurn` itself
  // (which forwards the caller's) and in each caller's argument object. Any
  // other occurrence is a hand-rolled settle that skipped the helper.
  const settles = [...SOURCE.matchAll(/errorCode: "([a-z_]+)"/g)].map((m) => m[1])
  expect(settles.length).toBeGreaterThan(0)

  // Each of these had its own five-step copy before the helper existed.
  const viaHelper = [...SOURCE.matchAll(/await refuseTurn\(\{\s*\n\s*errorCode: "([a-z_]+)"/g)].map(
    (m) => m[1]
  )
  expect(new Set(viaHelper)).toEqual(
    new Set([
      "managed_project_unavailable",
      "workspace_bundle_unavailable",
      "execution_run_start_failed",
      "shared_run_coordination_failed",
      "managed_worktree_unavailable",
      "task_workspace_unavailable",
      "environment_unavailable",
      "environment_setup_failed",
      "external_agent_not_selected",
      "external_agent_unavailable",
    ])
  )

  // And none of them kept a copy of the old inline sequence.
  const inlineSettles = SOURCE.split("await refuseTurn(")
    .slice(1)
    .join("")
    .match(/chatTurnPerformance\.finish\(sessionId, "failed"\)\n\s+await settleChatTurnForSession/g)
  expect(inlineSettles).toBeNull()
})

it("does not release the execution lease, which has exactly one owner", () => {
  // `lib/execution/chat-lease.ts` releases on any transition out of an active
  // status. A second release here would give one lease two owners.
  expect(refuseTurnBody()).not.toContain("releaseChatLease")
})

/**
 * A turn refused the managed working copy never opened a run of its own, so
 * `activeBySession[sessionId]` still holds the PREVIOUS turn's. The settle edge
 * that follows the refusal would release that one — and when the refusal is the
 * host's `pipeline workspace is already active`, that previous turn is the live
 * one which caused the refusal. A send that arrived mid-turn therefore tore the
 * working copy out from under an agent that was still streaming into it.
 */
describe("a refusal that never owned a working copy", () => {
  /** From the lease attempt to the first refusal that DOES own its run. */
  function leaseRefusalRegion(): string {
    const start = SOURCE.indexOf("let bundleTurnLease:")
    expect(start).toBeGreaterThan(-1)
    const nextOwningRefusal = SOURCE.indexOf('errorCode: "environment_unavailable"', start)
    expect(nextOwningRefusal).toBeGreaterThan(start)
    // Stop at that refusal's own `await refuseTurn({`, a line above its code.
    return SOURCE.slice(start, SOURCE.lastIndexOf("await refuseTurn({", nextOwningRefusal))
  }

  it("declares itself unowned at every workspace-lease refusal", () => {
    const region = leaseRefusalRegion()
    // Both of them: the lease that threw, and the lease that answered null.
    expect(region.match(/await refuseTurn\(\{/g)).toHaveLength(2)
    expect(region.match(/markTurnUnowned\(\)/g)).toHaveLength(2)
  })

  // The refusals AFTER the lease is held do own a run, and settling it on their
  // way out is the whole point of the settle edge.
  it("leaves the refusals that do own a run alone", () => {
    const afterLease = SOURCE.slice(SOURCE.indexOf('errorCode: "environment_unavailable"'))
    expect(afterLease).not.toContain("markTurnUnowned()")
  })

  /**
   * The mark is a silent no-op if the run id it reads is undefined, and a
   * silent no-op here means the working copy is torn out from under a live turn
   * with every test still green. Pinned against the cancel path rather than by
   * running the closure: that path has shipped this exact read for the abort
   * gesture, so agreeing with it is the check that matters.
   */
  it("reads the ending turn's id the way the proven cancel path does", () => {
    const reads = SOURCE.match(/const endingRunId = [\w.()]*\.sessions\[sessionId\]\?\.runId/g)
    expect(reads).toHaveLength(2)
    expect(SOURCE.match(/typeof endingRunId === "number"/g)).toHaveLength(2)
  })

  function leaseFailureBody(): string {
    const start = SOURCE.indexOf('console.error("workspace turn lease failed"')
    expect(start).toBeGreaterThan(-1)
    return SOURCE.slice(start, SOURCE.indexOf("const taskLease = bundleTurnLease", start))
  }

  /**
   * "Busy" and "unresolvable" are different codes, because the card renders the
   * code's own hint above the message and `workspaceUnavailable`'s tells the
   * reader to bind the workspace to a folder — the one move that cannot help a
   * binding that is already correct and merely held by a running turn.
   */
  it("distinguishes a busy working copy from one it cannot resolve", () => {
    const body = leaseFailureBody()
    // Whitespace-tolerant: the branch must pick the busy code, not merely
    // mention it somewhere in the same refusal.
    expect(body).toMatch(/isWorkspaceBusyRefusal\(error\)\s*\?\s*createDiagnostic\("workspaceBusy"/)
    expect(body).toMatch(/:\s*createDiagnostic\("workspaceUnavailable"/)
  })

  /**
   * The busy refusal is an English sentence naming an internal workspace key,
   * so the translated sentence is what `message` carries — it is mirrored onto
   * the legacy `errorMessage` that the mobile toast and the OS session
   * notification still render as prose. The host's own words survive in
   * `detail`, which the card now discloses. Every OTHER failure keeps the
   * host's words as its message: there they are the only account of the cause.
   */
  it("translates the refusal it can name and keeps the host's words for the rest", () => {
    const body = leaseFailureBody()
    expect(body).toContain('message: tInlineErr("workspaceBusy")')
    expect(body).toContain("detail: leaseFailure")
    expect(body).toContain("message: leaseFailure")
    expect(body).toContain(
      "const leaseFailure = error instanceof Error ? error.message : String(error)"
    )
  })
})
