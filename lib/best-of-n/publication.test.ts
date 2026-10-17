import { createBestOfNPublication } from "./publication"
import { integrateChangesets } from "@/lib/scm/integration/orchestrator"
import type { BestOfNGroup } from "@/types/best-of-n"
import type { AgentChangeset, ChangesetCheck, IntegrationRun } from "@/lib/scm/types"
import { defaultReviewPolicy } from "@/lib/scm/review/review-policy"

function fixture() {
  let group = {
    groupId: "g",
    baseSha: "base",
    targetRef: "refs/heads/result",
    phase: "awaitingSelection",
    selectedCandidateId: null,
    selectedHeadSha: null,
    archiveStatus: "pending",
    archiveError: null,
    candidates: [0, 1].map((index) => ({
      candidateId: `c${index}`,
      childSessionId: `s${index}`,
      changesetId: `cs${index}`,
      headSha: `head${index}`,
      hasChanges: true,
      status: "succeeded",
    })),
  } as BestOfNGroup
  const changesets = [0, 1].map((index) => ({
    changesetId: `cs${index}`,
    headSha: `head${index}`,
    baseSha: "base",
    sessionId: `s${index}`,
    targetRef: "refs/heads/result",
    state: "ready",
    requiredChecks: ["unit"],
    review: null,
  })) as AgentChangeset[]
  const check: ChangesetCheck = {
    headSha: "head0",
    profileId: "unit",
    outcome: "passed",
    tier: "os",
    reportDigest: "report",
    logTail: null,
    ranAt: 1,
  }
  const runs = new Map<string, IntegrationRun>()
  const scm = {
    getChangeset: jest.fn(
      async (id: string) => changesets.find((item) => item.changesetId === id) ?? null
    ),
    recordChangesetReview: jest.fn(async () => changesets[0]),
    approveChangeset: jest.fn(async () => changesets[0]),
    getIntegration: jest.fn(async (id: string) => runs.get(id) ?? null),
    abortIntegration: jest.fn(async (id: string) => {
      const run = runs.get(id)!
      runs.set(id, { ...run, state: "aborted" })
      // The Host returns a best-of-N winner to its reviewed state.
      for (const item of changesets)
        if (item.integrationId === id) Object.assign(item, { state: "approved" })
      return runs.get(id)!
    }),
  }
  const integrate = jest.fn(async () => {
    group = { ...group, phase: "published", integrationId: "integration" }
    return { kind: "published", analysis: {}, run: { integrationId: "integration" }, dropped: [] }
  })
  const deps = {
    get: jest.fn(async () => structuredClone(group)),
    select: jest.fn(async (_id: string, candidateId: string, headSha: string) => {
      group = {
        ...group,
        phase: "publishing",
        selectedCandidateId: candidateId,
        selectedHeadSha: headSha,
      }
      return group
    }),
    cancel: jest.fn(async () => (group = { ...group, phase: "cancelled" })),
    archive: jest.fn(async () => (group = { ...group, archiveStatus: "archived" })),
    scm,
    verify: jest.fn(async () => ({
      changeset: changesets[0],
      checks: [check],
      policy: defaultReviewPolicy(),
      risk: null,
      agent: null,
    })),
    runtime: jest.fn(async () => ({ integrate })),
    archiveSession: jest.fn(async (_id: string) => undefined),
    project: jest.fn(async () => undefined),
  }
  const api = createBestOfNPublication(deps as never)
  return { api, deps, group: () => group, changesets, check, integrate, runs }
}

it("picks manually and shows exact-head checks without publishing", async () => {
  const f = fixture()
  const result = await f.api.pick("g", "c0")
  expect(f.deps.select).toHaveBeenCalledWith("g", "c0", "head0")
  expect(result.checks[0].headSha).toBe("head0")
  expect(f.integrate).not.toHaveBeenCalled()
  expect(f.deps.scm.approveChangeset).not.toHaveBeenCalled()
})

it("publishes only the selected changeset with stop-on-conflict and archives only the loser", async () => {
  const f = fixture()
  await f.api.pick("g", "c0")
  expect((await f.api.publish("g")).outcome.kind).toBe("published")
  expect(f.integrate).toHaveBeenCalledWith(
    expect.objectContaining({
      changesetIds: ["cs0"],
      targetRef: "refs/heads/result",
      onConflict: "stop",
      requiredChecks: ["unit"],
    })
  )
  expect(f.deps.verify).toHaveBeenCalledTimes(2)
  expect(f.deps.archiveSession.mock.calls).toEqual([["s1"]])
})

it.each(["failed", "inconclusive"] as const)("never publishes a %s check", async (outcome) => {
  const f = fixture()
  await f.api.pick("g", "c0")
  f.check.outcome = outcome
  await expect(f.api.publish("g")).rejects.toThrow("did not pass")
  expect(f.integrate).not.toHaveBeenCalled()
})

it("rejects stale check receipts and a recaptured selected head", async () => {
  const f = fixture()
  await f.api.pick("g", "c0")
  f.check.headSha = "old"
  await expect(f.api.publish("g")).rejects.toThrow("did not pass")
  f.changesets[0].headSha = "recaptured"
  await expect(f.api.publish("g")).rejects.toThrow("recorded head")
  expect(f.integrate).not.toHaveBeenCalled()
})

it("refuses no-change and unknown candidates before selecting", async () => {
  const f = fixture()
  f.group().candidates[0].hasChanges = false
  await expect(f.api.pick("g", "c0")).rejects.toThrow("no publishable")
  await expect(f.api.pick("g", "missing")).rejects.toThrow("no publishable")
  expect(f.deps.select).not.toHaveBeenCalled()
})

it("workspace and session cleanup failures preserve the successful publication and can retry", async () => {
  const f = fixture()
  await f.api.pick("g", "c0")
  f.deps.archive.mockRejectedValueOnce(new Error("workspace cleanup failed"))
  f.deps.archiveSession.mockRejectedValueOnce(new Error("session cleanup failed"))
  const result = await f.api.publish("g")
  expect(result.group.phase).toBe("published")
  expect(result.outcome.kind).toBe("published")
  expect(result.archiveError).toContain("workspace cleanup failed")
  expect(result.archiveError).toContain("session cleanup failed")
  expect((await f.api.archive("g")).archiveError).toBeNull()
  expect(f.integrate).toHaveBeenCalledTimes(1)
})

it("explicit archive cancels unfinished work first", async () => {
  const f = fixture()
  await f.api.archive("g")
  expect(f.deps.cancel).toHaveBeenCalledWith("g")
  expect(f.deps.archiveSession.mock.calls).toEqual([["s0"], ["s1"]])
})

it("retains the publication receipt when the subsequent Host refresh is unavailable", async () => {
  const f = fixture()
  await f.api.pick("g", "c0")
  f.integrate.mockImplementationOnce(async () => {
    f.deps.get.mockRejectedValue(new Error("Host disconnected"))
    return { kind: "published", analysis: {}, run: { integrationId: "receipt" }, dropped: [] }
  })
  const result = await f.api.publish("g")
  expect(result.outcome.kind).toBe("published")
  expect(result.outcome.run?.integrationId).toBe("receipt")
  expect(result.archiveError).toBe("Host disconnected")
})

it("the UI publication path cannot expand its selected winner into a losing changeset", async () => {
  const f = fixture()
  await f.api.pick("g", "c0")
  const publishIntegration = jest.fn()
  const prepareIntegration = jest.fn(async (input: { changesetIds: string[] }) => {
    // Model the authoritative prepare guard; the Rust integration test below
    // exercises the real guard with two captured candidates and real Git.
    if (input.changesetIds.some((id) => id !== "cs0"))
      throw { code: "invalid_request", message: "best-of-N loser refused" }
    throw new Error("unexpected eligible composition")
  })
  f.deps.runtime.mockResolvedValue({
    integrate: (input: never) =>
      integrateChangesets(input, {
        host: {
          analyzeIntegration: async () => ({
            order: ["cs0", "cs1"],
            cycles: [],
            overlaps: [],
            predictedConflicts: [],
            prediction: "mergeTree",
          }),
          prepareIntegration,
          publishIntegration,
        } as never,
        acceptancePortFor: null,
      }),
  } as never)
  const result = await f.api.publish("g")
  expect(result.outcome.kind).toBe("blocked")
  expect(publishIntegration).not.toHaveBeenCalled()
  expect(f.deps.archive).not.toHaveBeenCalled()
})

it("releases an integration a dirty target refused, then the retry re-checks and publishes", async () => {
  const f = fixture()
  await f.api.pick("g", "c0")
  f.integrate.mockImplementationOnce(async () => {
    // Prepare moved the winner into the integration; publish was refused.
    const run = { integrationId: "held", state: "prepared" } as IntegrationRun
    f.runs.set("held", run)
    Object.assign(f.changesets[0], { state: "integrating", integrationId: "held" })
    return {
      kind: "blocked",
      analysis: {},
      run,
      dropped: [],
      reason: "target_checked_out_dirty",
    } as never
  })
  const refused = await f.api.publish("g")
  expect(refused.outcome.kind).toBe("blocked")
  expect(refused.releaseError).toBeNull()
  expect(f.deps.scm.abortIntegration).toHaveBeenCalledWith("held")
  expect(f.changesets[0].state).toBe("approved")
  expect(f.deps.archive).not.toHaveBeenCalled()

  // The person cleans the checked-out target and presses Publish again.
  const verifiedBefore = f.deps.verify.mock.calls.length
  expect((await f.api.publish("g")).outcome.kind).toBe("published")
  expect(f.deps.verify.mock.calls.length).toBe(verifiedBefore + 1)
  expect(f.integrate).toHaveBeenCalledTimes(2)
})

it("a retry releases an integration a Host restart left holding the winner", async () => {
  const f = fixture()
  await f.api.pick("g", "c0")
  f.runs.set("orphan", { integrationId: "orphan", state: "stale" } as IntegrationRun)
  Object.assign(f.changesets[0], { state: "integrating", integrationId: "orphan" })
  const result = await f.api.checks("g")
  expect(f.deps.scm.abortIntegration).toHaveBeenCalledWith("orphan")
  expect(result.checks[0].headSha).toBe("head0")
})

it("never aborts a run that is publishing or already settled", async () => {
  const f = fixture()
  await f.api.pick("g", "c0")
  f.runs.set("busy", { integrationId: "busy", state: "publishing" } as IntegrationRun)
  Object.assign(f.changesets[0], { state: "integrating", integrationId: "busy" })
  await expect(f.api.publish("g")).rejects.toThrow("held by integration busy (publishing)")
  expect(f.deps.scm.abortIntegration).not.toHaveBeenCalled()
  expect(f.integrate).not.toHaveBeenCalled()
})

it("reports a failed release without hiding the refusal", async () => {
  const f = fixture()
  await f.api.pick("g", "c0")
  f.deps.scm.abortIntegration.mockRejectedValueOnce(new Error("abort refused"))
  f.integrate.mockImplementationOnce(
    async () =>
      ({
        kind: "blocked",
        analysis: {},
        run: { integrationId: "held", state: "prepared" },
        dropped: [],
        reason: "target_checked_out_dirty",
      }) as never
  )
  const result = await f.api.publish("g")
  expect(result.outcome.reason).toBe("target_checked_out_dirty")
  expect(result.releaseError).toBe("abort refused")
})

it("after a restart releases only a publishing winner's held integration", async () => {
  const f = fixture()
  expect(await f.api.release("g")).toBe(false)
  await f.api.pick("g", "c0")
  expect(await f.api.release("g")).toBe(false)
  f.runs.set("held", { integrationId: "held", state: "prepared" } as IntegrationRun)
  Object.assign(f.changesets[0], { state: "integrating", integrationId: "held" })
  expect(await f.api.release("g")).toBe(true)
  expect(f.deps.scm.abortIntegration).toHaveBeenCalledWith("held")
  expect(f.changesets[0].state).toBe("approved")
  expect(f.integrate).not.toHaveBeenCalled()
})
