import { parseJUnitReport } from "../verify/junit-report"
import { MemoryAcceptancePort, junitFixture } from "./memory-acceptance"

let id = 0
const newId = () => `55555555-5555-4555-8555-${String(++id).padStart(12, "0")}`

function run(port: MemoryAcceptancePort, revision = "rev-1") {
  return port.runProfile({
    runId: "r",
    logicalStepId: "delegate:verify:1",
    profileId: "unit",
    revision,
  })
}

describe("MemoryAcceptancePort", () => {
  it("turns a scripted execution into a code-acceptance report through the real parsers", async () => {
    const content = junitFixture([
      { name: "a", status: "passed" },
      { name: 'b <x> & "y"', classname: "k", status: "failed", message: "1 < 2" },
    ])
    const port = new MemoryAcceptancePort(
      () => ({
        kind: "execution",
        exitCode: 1,
        report: { format: "junit", content },
        tier: "microvm",
      }),
      newId
    )
    const outcome = await run(port)
    if (outcome.kind !== "report") throw new Error("expected a report")
    expect(outcome.report).toMatchObject({
      status: "failed",
      level: "tool_verified",
      revision: "rev-1",
    })
    expect(outcome.report.checks.find((c) => c.check_id === "sandbox")?.summary).toBe(
      "tier=microvm"
    )
    expect(outcome.report.checks.find((c) => c.check_id === 'test:k::b <x> & "y"')?.summary).toBe(
      "failed: 1 < 2"
    )
    expect(port.runs).toEqual([
      { profileId: "unit", revision: "rev-1", logicalStepId: "delegate:verify:1" },
    ])
  })

  it("can answer about another revision, refuse, hand back a raw report, or crash", async () => {
    let step = 0
    const raw = {
      schema_version: "1.0.0" as const,
      report_id: newId(),
      status: "passed" as const,
      level: "model_review" as const,
      checks: [],
      revision: null,
      verifier_version: "x",
      artifact_refs: [],
    }
    const port = new MemoryAcceptancePort(({ run: index }) => {
      step = index
      if (index === 0)
        return {
          kind: "execution",
          exitCode: 0,
          report: { format: "junit", content: junitFixture([{ name: "a", status: "passed" }]) },
          reportRevision: "rev-0",
          requiredTests: ["missing"],
        }
      if (index === 1) return { kind: "refused", code: "SANDBOX_UNAVAILABLE" }
      if (index === 2) return { kind: "raw", report: raw }
      return { kind: "throw" }
    }, newId)
    const stale = await run(port, "rev-2")
    expect(stale).toMatchObject({ kind: "report", report: { revision: "rev-0", status: "failed" } })
    expect(await run(port)).toEqual({
      kind: "refused",
      code: "SANDBOX_UNAVAILABLE",
      message: "SANDBOX_UNAVAILABLE",
    })
    expect(await run(port)).toEqual({ kind: "report", report: raw })
    await expect(run(port)).rejects.toThrow("the sandbox crashed mid-run")
    expect(step).toBe(3)
  })

  it("writes JUnit fixtures a JUnit parser reads back", () => {
    const xml = junitFixture(
      [
        { name: "p", status: "passed" },
        { name: "s", status: "skipped" },
        { name: "e", status: "error" },
      ],
      "suite & co"
    )
    const parsed = parseJUnitReport(xml)
    expect(parsed).toMatchObject({
      ok: true,
      report: {
        totals: { discovered: 3, passed: 1, failed: 0, errored: 1, skipped: 1 },
        declared: { tests: 3, failures: 0, errors: 1, skipped: 1 },
      },
    })
  })
})
