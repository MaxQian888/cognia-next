import type { HarnessTaskCheck } from "@/types/harness/evolution"
import {
  checkTally,
  describeCheck,
  extractJsonObject,
  isDelivered,
  runTaskCheck,
  runTaskChecks,
  type TaskCheckInput,
} from "./checks"

const input: TaskCheckInput = {
  output: 'Total is 42.\n```json\n{"total": 42, "rows": 3}\n```',
  deliverables: [
    { path: "report.md", bytes: 120, text: "# Report" },
    { path: "empty.md", bytes: 0, text: "" },
  ],
  toolFailures: 1,
  filesObservable: true,
}

describe("runTaskCheck", () => {
  it.each<[HarnessTaskCheck, string]>([
    [{ kind: "deliverable-file", path: "report.md" }, "passed"],
    [{ kind: "deliverable-file", path: "missing.md" }, "failed"],
    [{ kind: "deliverable-file", path: "empty.md" }, "failed"],
    [{ kind: "output-contains", value: "TOTAL IS 42" }, "passed"],
    [{ kind: "output-contains", value: "TOTAL IS 42", caseSensitive: true }, "failed"],
    [{ kind: "output-not-contains", value: "error" }, "passed"],
    [{ kind: "output-not-contains", value: "42" }, "failed"],
    [{ kind: "output-json", requiredKeys: ["total"] }, "passed"],
    [{ kind: "output-json", requiredKeys: ["total", "avg"] }, "failed"],
    [{ kind: "max-tool-errors", max: 1 }, "passed"],
    [{ kind: "max-tool-errors", max: 0 }, "failed"],
    [{ kind: "acceptance-profile", profileId: "unit" }, "inconclusive"],
  ])("%j → %s", (check, status) => {
    const result = runTaskCheck(check, input)
    expect(result.status).toBe(status)
    expect(result.passed).toBe(status === "passed")
    expect(result.check).toBe(describeCheck(check))
  })

  it("is inconclusive about files when the run had no working directory", () => {
    expect(
      runTaskCheck(
        { kind: "deliverable-file", path: "report.md" },
        { ...input, filesObservable: false }
      ).status
    ).toBe("inconclusive")
  })

  it("reads acceptance outcomes the runner supplied", () => {
    const acceptance = new Map([["unit", { outcome: "failed" as const, detail: "2 tests failed" }]])
    expect(
      runTaskCheck({ kind: "acceptance-profile", profileId: "unit" }, { ...input, acceptance })
    ).toEqual({
      check: "acceptance profile unit",
      passed: false,
      status: "failed",
      detail: "2 tests failed",
    })
  })
})

describe("extractJsonObject", () => {
  it("reads whole-text JSON or the first fenced block", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(extractJsonObject("intro\n```json\n[1,2]\n```")).toEqual([1, 2])
    expect(extractJsonObject("no json here")).toBeUndefined()
  })

  it("does not count a JSON array as an object with keys", () => {
    expect(
      runTaskCheck({ kind: "output-json", requiredKeys: ["a"] }, { ...input, output: "[1]" }).status
    ).toBe("failed")
  })
})

describe("isDelivered", () => {
  it("needs every expected deliverable, non-empty", () => {
    expect(isDelivered({ expectedDeliverables: ["report.md"] }, input, undefined)).toBe(true)
    expect(isDelivered({ expectedDeliverables: ["report.md", "empty.md"] }, input, undefined)).toBe(
      false
    )
    expect(
      isDelivered(
        { expectedDeliverables: ["report.md"] },
        { ...input, filesObservable: false },
        undefined
      )
    ).toBe(false)
  })

  it("needs a non-empty answer when no file is expected, and never delivers on error", () => {
    expect(isDelivered({}, input, undefined)).toBe(true)
    expect(isDelivered({}, { ...input, output: "  " }, undefined)).toBe(false)
    expect(isDelivered({}, input, "timed out")).toBe(false)
  })
})

describe("checkTally", () => {
  it("counts by status", () => {
    const results = runTaskChecks(
      [
        { kind: "deliverable-file", path: "report.md" },
        { kind: "max-tool-errors", max: 0 },
        { kind: "acceptance-profile", profileId: "x" },
      ],
      input
    )
    expect(checkTally(results)).toEqual({ passed: 1, failed: 1, inconclusive: 1, total: 3 })
  })
})
