import {
  BASH_THRASH_THRESHOLD,
  FILE_EDIT_THRASH_THRESHOLD,
  bashCommandPrefix,
  detectFriction,
  detectThinkingSignals,
  isGitCommit,
  isPermissionDenialText,
  parseTestSummary,
} from "@/lib/analysis/session-signals"

describe("detectFriction", () => {
  it("flags course-correction phrases", () => {
    expect(detectFriction("actually that's wrong, undo it")).toEqual(
      expect.arrayContaining(["actually", "undo", "thats-wrong"])
    )
    expect(detectFriction("no, do it differently")).toContain("no")
    expect(detectFriction("wait stop")).toEqual(expect.arrayContaining(["wait", "stop"]))
  })

  it("returns nothing for neutral text or empty input", () => {
    expect(detectFriction("please add a button")).toEqual([])
    expect(detectFriction("")).toEqual([])
  })

  it("does not match 'no' mid-sentence (only sentence-leading)", () => {
    expect(detectFriction("there is no problem")).not.toContain("no")
  })
})

describe("detectThinkingSignals", () => {
  it("detects planning, uncertainty, and alternatives", () => {
    expect(detectThinkingSignals("First I will plan the approach")).toContain("planning")
    expect(detectThinkingSignals("I'm not sure, maybe this works")).toContain("uncertainty")
    expect(detectThinkingSignals("instead we could use another option")).toContain("alternatives")
  })

  it("returns nothing for empty input", () => {
    expect(detectThinkingSignals("")).toEqual([])
  })
})

describe("parseTestSummary", () => {
  it("parses passed + failed counts", () => {
    expect(parseTestSummary("Tests: 12 passed, 3 failed, 15 total")).toEqual({
      passed: 12,
      failed: 3,
    })
    expect(parseTestSummary("5 passing")).toEqual({ passed: 5, failed: 0 })
    expect(parseTestSummary("2 failing")).toEqual({ passed: 0, failed: 2 })
  })

  it("returns null when there is no test summary", () => {
    expect(parseTestSummary("file written")).toBeNull()
    expect(parseTestSummary("")).toBeNull()
  })
})

describe("bashCommandPrefix", () => {
  it("returns the first two words", () => {
    expect(bashCommandPrefix("npm run build --watch")).toBe("npm run")
    expect(bashCommandPrefix("ls")).toBe("ls")
  })

  it("returns empty string for blank commands", () => {
    expect(bashCommandPrefix("   ")).toBe("")
    expect(bashCommandPrefix("")).toBe("")
  })
})

describe("isGitCommit", () => {
  it("matches git commit invocations", () => {
    expect(isGitCommit('git commit -m "x"')).toBe(true)
    expect(isGitCommit("git status")).toBe(false)
    expect(isGitCommit("")).toBe(false)
  })
})

describe("isPermissionDenialText", () => {
  it("recognises denial phrasing", () => {
    expect(isPermissionDenialText("Permission denied")).toBe(true)
    expect(isPermissionDenialText("This action requires approval")).toBe(true)
    expect(isPermissionDenialText("ok")).toBe(false)
  })
})

it("exports the thrash thresholds", () => {
  expect(BASH_THRASH_THRESHOLD).toBe(5)
  expect(FILE_EDIT_THRASH_THRESHOLD).toBe(3)
})
