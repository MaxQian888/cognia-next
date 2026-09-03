/**
 * The derivation behind "open what this run produced".
 *
 * Every shape here is a real executor return value, copied from
 * `lib/scheduler/executors/`. The point of the suite is that adding a field to
 * one of those returns cannot silently stop the link appearing.
 */

import { runArtifactLinks } from "./run-artifact-link"

describe("runArtifactLinks", () => {
  it("finds the session a chat / agent / skill run wrote into", () => {
    expect(
      runArtifactLinks({
        sessionId: "sess-1",
        finalResponse: "done",
        duration: 1200,
        tokenUsage: {},
      })
    ).toEqual([{ kind: "session", id: "sess-1", href: null }])
  })

  it("puts the goal ahead of the session it ran in", () => {
    // A goal run carries both. The goal is what the user asked for, so listing
    // the session first would bury it.
    expect(
      runArtifactLinks({ goalId: "goal-1", sessionId: "sess-1", status: "completed", turns: 4 })
    ).toEqual([
      { kind: "goal", id: "goal-1", href: "/goals" },
      { kind: "session", id: "sess-1", href: null },
    ])
  })

  it("finds a plan", () => {
    expect(runArtifactLinks({ planId: "plan-1", status: "completed" })).toEqual([
      { kind: "plan", id: "plan-1", href: "/agent-runs" },
    ])
  })

  it("finds a squad", () => {
    expect(runArtifactLinks({ teamId: "team-1", status: "completed" })).toEqual([
      { kind: "squad", id: "team-1", href: "/squads" },
    ])
  })

  it("falls back to a workflow run id only when nothing better exists", () => {
    // Several executors carry a `runId` meaning something else, so it must not
    // outrank a real product.
    expect(runArtifactLinks({ runId: "wf-1", status: "completed" })).toEqual([
      { kind: "workflow-run", id: "wf-1", href: "/workflows" },
    ])
    expect(runArtifactLinks({ runId: "wf-1", sessionId: "sess-1" })).toEqual([
      { kind: "session", id: "sess-1", href: null },
    ])
  })

  it("returns nothing for a run that produced no addressable artifact", () => {
    expect(runArtifactLinks({ exit_code: 0, stdout: "ok" })).toEqual([])
    expect(runArtifactLinks(undefined)).toEqual([])
    expect(runArtifactLinks(null)).toEqual([])
    expect(runArtifactLinks("a string")).toEqual([])
    expect(runArtifactLinks([{ sessionId: "sess-1" }])).toEqual([])
  })

  it("ignores an empty or non-string id rather than linking nowhere", () => {
    expect(runArtifactLinks({ sessionId: "" })).toEqual([])
    expect(runArtifactLinks({ sessionId: 42 })).toEqual([])
  })
})
