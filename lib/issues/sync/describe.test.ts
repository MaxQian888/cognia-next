import { MissingGithubCredentialError } from "@/lib/issues/sync-runner"
import type { RunWorkspaceIssueSyncResult } from "./runner"
import type { IssueSyncBinding, ReconcileOutcome } from "./types"
import { summarizeSync, summarizeSyncParts, syncSummaryMessage } from "./describe"

const binding: IssueSyncBinding = {
  providerId: "github",
  projectId: "w1",
  issueProjectId: "p1",
  projectKey: "MERC",
  resource: { kind: "github-repo", repoFullName: "o/r", addedAt: 1 },
  key: "o/r",
}

function outcome(over: Partial<ReconcileOutcome> = {}): ReconcileOutcome {
  return {
    binding,
    created: 0,
    updated: 0,
    pushed: 0,
    queued: 0,
    conflicts: 0,
    linked: 0,
    cycles: 0,
    notModified: false,
    truncated: false,
    ...over,
  }
}

function result(over: Partial<RunWorkspaceIssueSyncResult> = {}): RunWorkspaceIssueSyncResult {
  return {
    bindingCount: 1,
    mirror: { repoCount: 0, results: [], failures: [] },
    outcomes: [],
    failures: [],
    ...over,
  }
}

describe("summarizeSync", () => {
  it("names the four quiet outcomes", () => {
    expect(summarizeSync(result({ bindingCount: 0 }))).toEqual({ kind: "no-bindings" })
    expect(summarizeSync(result())).toEqual({ kind: "up-to-date" })
    expect(
      summarizeSync(
        result({
          mirror: {
            repoCount: 1,
            results: [],
            failures: [{ repoFullName: "o/r", error: new MissingGithubCredentialError("o/r") }],
          },
        })
      )
    ).toEqual({ kind: "no-credential" })
    expect(summarizeSync(result({ failures: [{ binding, error: new Error("boom") }] }))).toEqual({
      kind: "failed",
      names: ["o/r"],
      parts: [],
    })
  })

  it("lists only the non-zero counts, in reading order", () => {
    const summary = summarizeSync(
      result({
        outcomes: [outcome({ created: 2, conflicts: 1 }), outcome({ pushed: 3, queued: 1 })],
        mirror: {
          repoCount: 1,
          results: [{ repoFullName: "o/m", written: 4, notModified: false, truncated: false }],
          failures: [],
        },
      })
    )
    expect(summary).toEqual({
      kind: "changed",
      parts: [
        { part: "imported", count: 2 },
        { part: "pushed", count: 3 },
        { part: "conflicts", count: 1 },
        { part: "queued", count: 1 },
        { part: "written", count: 4 },
      ],
    })
    expect(summarizeSyncParts(result())).toEqual([])
  })
})

describe("syncSummaryMessage", () => {
  const t = (key: string, values?: Record<string, string | number>) =>
    values ? `${key}:${JSON.stringify(values)}` : key
  it("joins the parts with the locale's joiner and maps kinds to levels", () => {
    expect(
      syncSummaryMessage(
        {
          kind: "changed",
          parts: [
            { part: "imported", count: 2 },
            { part: "pushed", count: 1 },
          ],
        },
        t
      )
    ).toEqual({
      level: "success",
      message: 'sync.parts.imported:{"count":2}sync.joinersync.parts.pushed:{"count":1}',
    })
    expect(syncSummaryMessage({ kind: "up-to-date" }, t)).toEqual({
      level: "success",
      message: "sync.upToDate",
    })
    expect(syncSummaryMessage({ kind: "no-bindings" }, t)).toEqual({
      level: "info",
      message: "sync.noBindings",
    })
    expect(syncSummaryMessage({ kind: "no-credential" }, t)).toEqual({
      level: "error",
      message: "sync.noCredential",
    })
    expect(syncSummaryMessage({ kind: "failed", names: ["a", "b"], parts: [] }, t)).toEqual({
      level: "error",
      message: 'sync.failedBindings:{"names":"a, b"}',
    })
  })
})
