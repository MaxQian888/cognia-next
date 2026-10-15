import type {
  AcceptancePort,
  AcceptanceRunOutcome,
  VerificationReport,
} from "@cognia/router-fusion"

import type { ScmHost } from "../host"
import type {
  ChangesetCheck,
  IntegrationAnalysis,
  IntegrationItem,
  IntegrationRun,
  PrepareIntegration,
} from "../types"
import { MAX_STALE_REBUILDS, integrateChangesets, integrationRootForRevision } from "./orchestrator"

/**
 * A host that composes changesets the way the real one does, at the level the
 * orchestrator can observe: `conflicting` ids conflict, `breaking` ids make
 * any candidate containing them fail verification, and `moves` publishes fail
 * with target_moved before one succeeds.
 */
function fakeHost(
  options: {
    conflicting?: string[]
    moves?: number
    cycles?: string[][]
    /** Checks a changeset owes on its own, as the host records them at capture. */
    owed?: Record<string, string[]>
  } = {}
) {
  const runs = new Map<string, IntegrationRun>()
  let counter = 0
  let movesLeft = options.moves ?? 0
  let tip = 0
  const candidateOf = (items: IntegrationItem[]) =>
    `cand-${tip}-${items
      .filter((item) => item.outcome === "merged")
      .map((item) => item.changesetId)
      .join("+")}`

  const compose = (run: IntegrationRun, ids: string[]): IntegrationRun => {
    const items: IntegrationItem[] = ids.map((changesetId) => {
      const previous = run.items.find((item) => item.changesetId === changesetId)
      if (previous?.outcome === "dropped") return previous
      const conflicted = options.conflicting?.includes(changesetId) ?? false
      return {
        changesetId,
        headSha: `head-${changesetId}`,
        outcome: conflicted ? "conflicted" : "merged",
        conflictFiles: conflicted ? ["shared.ts"] : [],
        commitSha: conflicted ? null : `commit-${changesetId}`,
      }
    })
    const merged = items.some((item) => item.outcome === "merged")
    const requiredChecks = [
      ...new Set([
        ...run.requestedChecks,
        ...items
          .filter((item) => item.outcome === "merged")
          .flatMap((item) => options.owed?.[item.changesetId] ?? []),
      ]),
    ]
    const stopped = run.onConflict === "stop" && items.some((item) => item.outcome === "conflicted")
    return {
      ...run,
      items,
      expectedOldSha: `tip-${tip}`,
      candidateSha: merged && !stopped ? candidateOf(items) : null,
      state: merged && !stopped ? "prepared" : "conflicted",
      checks: [],
      requiredChecks,
    }
  }

  const host: jest.Mocked<ScmHost> = {
    captureChangeset: jest.fn(),
    getChangeset: jest.fn(),
    listChangesets: jest.fn(),
    markChangesetReady: jest.fn(),
    recordChangesetReview: jest.fn(),
    recordChangesetCheck: jest.fn(),
    approveChangeset: jest.fn(),
    abandonChangeset: jest.fn(),
    changesetEligibility: jest.fn(),
    analyzeIntegration: jest.fn(async (ids: string[]): Promise<IntegrationAnalysis> => ({
      order: [...ids],
      predictedConflicts: [],
      overlaps: [],
      prediction: "mergeTree",
      cycles: options.cycles ?? [],
    })),
    prepareIntegration: jest.fn(async (input: PrepareIntegration) => {
      counter += 1
      const base: IntegrationRun = {
        integrationId: `int-${counter}`,
        repoCommonDir: "/repo/.git",
        targetRef: input.targetRef,
        strategy: input.strategy,
        onConflict: input.onConflict,
        expectedOldSha: `tip-${tip}`,
        candidateSha: null,
        resultSha: null,
        state: "preparing",
        items: [],
        worktreePath: "/data/integration/abc",
        attempt: 1,
        opLog: [],
        checks: [],
        requiredChecks: [],
        requestedChecks: input.requiredChecks ?? [],
        error: null,
        createdAt: 0,
        updatedAt: 0,
      }
      const run = compose(base, input.changesetIds)
      runs.set(run.integrationId, run)
      return run
    }),
    recordIntegrationCheck: jest.fn(
      async (id: string, candidateSha: string, check: ChangesetCheck) => {
        const run = runs.get(id)!
        if (run.candidateSha !== candidateSha) throw { code: "stale_candidate", message: "stale" }
        const next = {
          ...run,
          checks: [...run.checks.filter((c) => c.profileId !== check.profileId), check],
        }
        runs.set(id, next)
        return next
      }
    ),
    publishIntegration: jest.fn(
      async (id: string, candidateSha: string, _requiredChecks: string[]) => {
        const run = runs.get(id)!
        if (run.candidateSha !== candidateSha) throw { code: "stale_candidate", message: "stale" }
        if (movesLeft > 0) {
          movesLeft -= 1
          tip += 1
          const stale = { ...run, state: "stale" as const }
          runs.set(id, stale)
          throw { code: "target_moved", message: "target moved", retryable: false }
        }
        const published = { ...run, state: "published" as const, resultSha: candidateSha }
        runs.set(id, published)
        return published
      }
    ),
    rebuildIntegration: jest.fn(async (id: string) => {
      const run = runs.get(id)!
      if (run.state !== "stale") throw { code: "invalid_state", message: run.state }
      const ids = run.items.map((item) => item.changesetId)
      const rebuilt = compose({ ...run, attempt: run.attempt + 1 }, ids)
      runs.set(id, rebuilt)
      return rebuilt
    }),
    dropIntegrationItem: jest.fn(async (id: string, changesetId: string) => {
      const run = runs.get(id)!
      const items = run.items.map((item) =>
        item.changesetId === changesetId ? { ...item, outcome: "dropped" as const } : item
      )
      const left = items.some((item) => item.outcome !== "dropped" && item.outcome !== "conflicted")
      const next = {
        ...run,
        items,
        candidateSha: null,
        checks: [],
        state: left ? ("stale" as const) : ("failed" as const),
      }
      runs.set(id, next)
      return next
    }),
    abortIntegration: jest.fn(async (id: string) => {
      const next = { ...runs.get(id)!, state: "aborted" as const }
      runs.set(id, next)
      return next
    }),
    rollbackIntegration: jest.fn(),
    getIntegration: jest.fn(async (id: string) => runs.get(id) ?? null),
    listIntegrations: jest.fn(),
  }
  return host
}

function report(status: "passed" | "failed", revision: string): AcceptanceRunOutcome {
  return {
    kind: "report",
    report: {
      schema_version: 1,
      report_id: "11111111-1111-4111-8111-111111111111",
      status,
      level: "runtime",
      revision,
      verifier_version: "t",
      artifact_refs: [],
      checks: [],
    } as unknown as VerificationReport,
  }
}

/** Verification fails for any candidate that contains one of `breaking`. */
function portFor(breaking: string[] = []) {
  const calls: Array<{ revision: string; root: string | null }> = []
  const profiles: string[] = []
  const factory = (run: IntegrationRun): AcceptancePort => ({
    runProfile: async ({ revision, profileId }) => {
      profiles.push(profileId)
      calls.push({ revision, root: await integrationRootForRevision(run)(revision) })
      const broken = breaking.some((id) => revision.includes(id))
      return report(broken ? "failed" : "passed", revision)
    },
  })
  return { factory, calls, profiles }
}

const input = (
  changesetIds: string[],
  overrides: Partial<Parameters<typeof integrateChangesets>[0]> = {}
) => ({
  changesetIds,
  targetRef: "refs/heads/main",
  strategy: "merge" as const,
  onConflict: "skip" as const,
  requiredChecks: ["unit"],
  signal: new AbortController().signal,
  ...overrides,
})

describe("integrateChangesets", () => {
  it("verifies the exact candidate in the integration worktree and publishes it", async () => {
    const host = fakeHost()
    const port = portFor()
    const outcome = await integrateChangesets(input(["a", "b"]), {
      host,
      acceptancePortFor: port.factory,
    })
    expect(outcome.kind).toBe("published")
    expect(outcome.run?.resultSha).toBe("cand-0-a+b")
    expect(port.calls).toEqual([{ revision: "cand-0-a+b", root: "/data/integration/abc" }])
    expect(host.publishIntegration).toHaveBeenCalledWith("int-1", "cand-0-a+b", ["unit"])
  })

  it("binds the checks at prepare and verifies what each composed changeset owes", async () => {
    const host = fakeHost({ owed: { b: ["e2e"] } })
    const port = portFor()
    const outcome = await integrateChangesets(input(["a", "b"]), {
      host,
      acceptancePortFor: port.factory,
    })
    expect(host.prepareIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ requiredChecks: ["unit"] })
    )
    expect(port.profiles.sort()).toEqual(["e2e", "unit"])
    expect(outcome.kind).toBe("published")
    expect(host.publishIntegration).toHaveBeenCalledWith("int-1", "cand-0-a+b", ["unit", "e2e"])
  })

  it("never publishes a changeset's own check unverified when the caller names none", async () => {
    const host = fakeHost({ owed: { a: ["unit"] } })
    const outcome = await integrateChangesets(input(["a"], { requiredChecks: [] }), {
      host,
      acceptancePortFor: null,
    })
    expect(outcome).toMatchObject({ kind: "blocked", reason: "checks_unmet" })
    expect(host.publishIntegration).not.toHaveBeenCalled()
  })

  it("integrates the disjoint changesets and records the conflicting one under skip", async () => {
    const host = fakeHost({ conflicting: ["c"] })
    const outcome = await integrateChangesets(input(["a", "b", "c"]), {
      host,
      acceptancePortFor: portFor().factory,
    })
    expect(outcome.kind).toBe("published")
    expect(outcome.run?.items.map((item) => [item.changesetId, item.outcome])).toEqual([
      ["a", "merged"],
      ["b", "merged"],
      ["c", "conflicted"],
    ])
  })

  it("stops on the first conflict under stop and gives the queue back", async () => {
    const host = fakeHost({ conflicting: ["b"] })
    const outcome = await integrateChangesets(input(["a", "b"], { onConflict: "stop" }), {
      host,
      acceptancePortFor: portFor().factory,
    })
    expect(outcome.kind).toBe("conflicted")
    expect(host.abortIntegration).toHaveBeenCalledWith("int-1")
    expect(host.publishIntegration).not.toHaveBeenCalled()
  })

  it("rebuilds on the new tip when the target moved, and verifies again", async () => {
    const host = fakeHost({ moves: 2 })
    const port = portFor()
    const outcome = await integrateChangesets(input(["a"]), {
      host,
      acceptancePortFor: port.factory,
    })
    expect(outcome.kind).toBe("published")
    expect(host.rebuildIntegration).toHaveBeenCalledTimes(2)
    // Each rebuilt candidate was verified before it was published.
    expect(port.calls.map((call) => call.revision)).toEqual(["cand-0-a", "cand-1-a", "cand-2-a"])
    expect(outcome.run?.resultSha).toBe("cand-2-a")
  })

  it("gives up after the stale budget instead of chasing a busy target forever", async () => {
    const host = fakeHost({ moves: MAX_STALE_REBUILDS + 1 })
    const outcome = await integrateChangesets(input(["a"]), {
      host,
      acceptancePortFor: portFor().factory,
    })
    expect(outcome).toEqual(expect.objectContaining({ kind: "blocked", reason: "target_moved" }))
    expect(host.rebuildIntegration).toHaveBeenCalledTimes(MAX_STALE_REBUILDS)
  })

  it("isolates the culprit of a failed verification and integrates the rest", async () => {
    const host = fakeHost()
    const port = portFor(["b"])
    const outcome = await integrateChangesets(input(["a", "b", "c"]), {
      host,
      acceptancePortFor: port.factory,
    })
    expect(outcome.kind).toBe("published")
    // c dropped first (last composed), still failing; then b; then a+... passes.
    expect(outcome.dropped).toEqual(["c", "b"])
    expect(outcome.run?.resultSha).toBe("cand-0-a")
  })

  it("fails when no subset passes, and aborts the run", async () => {
    const host = fakeHost()
    const outcome = await integrateChangesets(input(["a", "b"]), {
      host,
      acceptancePortFor: portFor(["a", "b"]).factory,
    })
    expect(outcome).toEqual(
      expect.objectContaining({ kind: "failed", reason: "checks_unmet", dropped: ["b", "a"] })
    )
    expect(host.publishIntegration).not.toHaveBeenCalled()
  })

  it("never publishes when checks are required and no port can verify", async () => {
    const host = fakeHost()
    const outcome = await integrateChangesets(input(["a"]), { host, acceptancePortFor: null })
    expect(outcome).toEqual(expect.objectContaining({ kind: "blocked", reason: "checks_unmet" }))
    expect(host.publishIntegration).not.toHaveBeenCalled()
    expect(host.abortIntegration).toHaveBeenCalled()
  })

  it("publishes without verification only when nothing is required", async () => {
    const host = fakeHost()
    const outcome = await integrateChangesets(input(["a"], { requiredChecks: [] }), {
      host,
      acceptancePortFor: null,
    })
    expect(outcome.kind).toBe("published")
  })

  it("refuses a dependency cycle before preparing anything", async () => {
    const host = fakeHost({ cycles: [["a", "b"]] })
    const outcome = await integrateChangesets(input(["a", "b"]), {
      host,
      acceptancePortFor: portFor().factory,
    })
    expect(outcome).toEqual(
      expect.objectContaining({ kind: "blocked", reason: "cycles", run: null })
    )
    expect(host.prepareIntegration).not.toHaveBeenCalled()
  })

  it("returns a refused prepare to the person with its code", async () => {
    const host = fakeHost()
    host.prepareIntegration.mockRejectedValueOnce({ code: "ineligible", message: "missing review" })
    const outcome = await integrateChangesets(input(["a"]), {
      host,
      acceptancePortFor: portFor().factory,
    })
    expect(outcome).toEqual(
      expect.objectContaining({ kind: "blocked", reason: "ineligible", message: "missing review" })
    )
  })

  it("does not retry a dirty checked-out target", async () => {
    const host = fakeHost()
    host.publishIntegration.mockRejectedValueOnce({
      code: "target_checked_out_dirty",
      message: "/repo",
    })
    const outcome = await integrateChangesets(input(["a"]), {
      host,
      acceptancePortFor: portFor().factory,
    })
    expect(outcome).toEqual(
      expect.objectContaining({ kind: "blocked", reason: "target_checked_out_dirty" })
    )
    expect(host.rebuildIntegration).not.toHaveBeenCalled()
  })

  it("aborts the run when the caller cancels", async () => {
    const host = fakeHost()
    const controller = new AbortController()
    controller.abort()
    const outcome = await integrateChangesets(input(["a"], { signal: controller.signal }), {
      host,
      acceptancePortFor: portFor().factory,
    })
    expect(outcome).toEqual(expect.objectContaining({ kind: "blocked", reason: "aborted" }))
    expect(host.abortIntegration).toHaveBeenCalled()
  })

  it("answers only the candidate from the run's worktree", async () => {
    const root = integrationRootForRevision({ candidateSha: "c1", worktreePath: "/w" })
    await expect(root("c1")).resolves.toBe("/w")
    await expect(root("other")).resolves.toBeNull()
    await expect(
      integrationRootForRevision({ candidateSha: null, worktreePath: "/w" })("c1")
    ).resolves.toBeNull()
  })
})
