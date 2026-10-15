import type {
  AcceptancePort,
  AcceptanceRunOutcome,
  VerificationReport,
} from "@cognia/router-fusion"

import { ACCEPTANCE_LOG_TAIL_CHARS } from "@/lib/router-fusion/verify/code-acceptance-host"

import { checkFromOutcome, runChangesetChecks, unmetChecks } from "./changeset-checks"

const SHA = "a".repeat(40)

function report(
  status: VerificationReport["status"],
  revision: string | null = SHA
): AcceptanceRunOutcome {
  return {
    kind: "report",
    report: {
      schema_version: 1,
      report_id: "11111111-1111-4111-8111-111111111111",
      status,
      level: "runtime",
      revision,
      verifier_version: "test",
      artifact_refs: [],
      checks: [
        {
          check_id: "tests",
          kind: "test",
          status,
          summary: "12 tests",
          executed_by: "runtime",
          artifact_refs: [],
        },
        {
          check_id: "sandbox_confinement",
          kind: "sandbox",
          status: "passed",
          summary: "tier=os network=off_enforced backend=seatbelt",
          executed_by: "runtime",
          artifact_refs: [],
        },
      ],
    } as unknown as VerificationReport,
  }
}

describe("checkFromOutcome", () => {
  it("records a passed report against the tested revision with its tier", () => {
    expect(checkFromOutcome("unit", SHA, report("passed"), 5)).toEqual({
      headSha: SHA,
      profileId: "unit",
      outcome: "passed",
      tier: "os",
      reportDigest: "11111111-1111-4111-8111-111111111111",
      logTail: "[passed] tests: 12 tests",
      ranAt: 5,
    })
  })

  it.each([
    ["failed", "failed"],
    ["inconclusive", "inconclusive"],
    ["not_applicable", "inconclusive"],
  ] as const)("maps a %s report to %s", (status, outcome) => {
    expect(checkFromOutcome("unit", SHA, report(status), 1).outcome).toBe(outcome)
  })

  it("records a refusal as inconclusive with its code, never as a pass", () => {
    const check = checkFromOutcome(
      "unit",
      SHA,
      { kind: "refused", code: "SANDBOX_UNAVAILABLE", message: "no tier" },
      1
    )
    expect(check).toEqual(
      expect.objectContaining({
        outcome: "inconclusive",
        tier: null,
        logTail: "SANDBOX_UNAVAILABLE: no tier",
      })
    )
  })

  it("refuses a report that names a different revision", () => {
    const check = checkFromOutcome("unit", SHA, report("passed", "b".repeat(40)), 1)
    expect(check.outcome).toBe("inconclusive")
    expect(check.logTail).toContain("expected")
  })

  it("clips the log tail", () => {
    const outcome: AcceptanceRunOutcome = {
      kind: "refused",
      code: "X",
      message: "y".repeat(ACCEPTANCE_LOG_TAIL_CHARS * 2),
    }
    expect(checkFromOutcome("unit", SHA, outcome, 1).logTail).toHaveLength(
      ACCEPTANCE_LOG_TAIL_CHARS
    )
  })
})

describe("runChangesetChecks", () => {
  it("runs each profile in order against the revision", async () => {
    const runProfile = jest.fn(async ({ profileId }: { profileId: string }) =>
      profileId === "lint" ? report("failed") : report("passed")
    )
    const port = { runProfile } as unknown as AcceptancePort
    const checks = await runChangesetChecks({
      port,
      runId: "cs-1",
      revision: SHA,
      profileIds: ["unit", "lint"],
      signal: new AbortController().signal,
      now: () => 9,
    })
    expect(checks.map((check) => [check.profileId, check.outcome])).toEqual([
      ["unit", "passed"],
      ["lint", "failed"],
    ])
    expect(runProfile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runId: "cs-1",
        revision: SHA,
        profileId: "unit",
        logicalStepId: "scm-check:unit",
      })
    )
  })

  it("records a throwing port as inconclusive and keeps going", async () => {
    const port = {
      runProfile: jest
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(report("passed")),
    } as unknown as AcceptancePort
    const checks = await runChangesetChecks({
      port,
      runId: "cs-1",
      revision: SHA,
      profileIds: ["a", "b"],
      signal: new AbortController().signal,
    })
    expect(checks[0]).toEqual(
      expect.objectContaining({ outcome: "inconclusive", logTail: "ACCEPTANCE_RUN_THREW: boom" })
    )
    expect(checks[1].outcome).toBe("passed")
  })

  it("stops when aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const port = { runProfile: jest.fn() } as unknown as AcceptancePort
    await expect(
      runChangesetChecks({
        port,
        runId: "x",
        revision: SHA,
        profileIds: ["a"],
        signal: controller.signal,
      })
    ).resolves.toEqual([])
    expect(port.runProfile).not.toHaveBeenCalled()
  })
})

describe("unmetChecks", () => {
  it("counts only a pass at the same revision", () => {
    const passedHere = checkFromOutcome("unit", SHA, report("passed"), 1)
    const passedElsewhere = {
      ...checkFromOutcome("lint", SHA, report("passed"), 1),
      headSha: "b".repeat(40),
    }
    const failed = checkFromOutcome("e2e", SHA, report("failed"), 1)
    expect(
      unmetChecks(["unit", "lint", "e2e", "docs"], [passedHere, passedElsewhere, failed], SHA)
    ).toEqual(["lint", "e2e", "docs"])
  })
})
