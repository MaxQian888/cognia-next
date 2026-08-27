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
      "managed_worktree_unavailable",
      "task_workspace_unavailable",
      "environment_unavailable",
      "environment_setup_failed",
      "external_agent_not_selected",
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
