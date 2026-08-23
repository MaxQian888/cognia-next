import { parseVerificationOutput, verificationOutputText } from "./parse"

const JEST_PASS = `
PASS node lib/execution/install-execution-control.test.ts
Test Suites: 2 passed, 2 total
Tests:       10 passed, 10 total
Snapshots:   0 total
Time:        1.149 s
`

const JEST_FAIL = `
Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 2 skipped, 10 passed, 13 total
Time:        4.2 s
`

const VITEST = `
 Test Files  1 failed | 2 passed (3)
      Tests  3 failed | 10 passed | 1 skipped (14)
   Duration  1.23s
`

const PLAYWRIGHT = `
  2 failed
  1 flaky
  10 passed (3.4s)
  1 skipped
`

const CARGO = `
test result: ok. 10 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.12s
`

const CARGO_TWO_CRATES = `
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
test result: FAILED. 6 passed; 2 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.20s
`

it("parses a passing jest run", () => {
  expect(parseVerificationOutput("jest", JEST_PASS)).toEqual({
    conclusion: "passed",
    passed: 10,
    failed: 0,
    skipped: 0,
    total: 10,
    durationMs: 1149,
  })
})

it("parses a failing jest run", () => {
  expect(parseVerificationOutput("jest", JEST_FAIL)).toMatchObject({
    conclusion: "failed",
    passed: 10,
    failed: 1,
    skipped: 2,
    total: 13,
  })
})

it("parses vitest", () => {
  expect(parseVerificationOutput("vitest", VITEST)).toMatchObject({
    conclusion: "failed",
    passed: 10,
    failed: 3,
    skipped: 1,
    total: 14,
  })
})

it("parses playwright and counts flaky as passed but keeps it in the total", () => {
  expect(parseVerificationOutput("playwright", PLAYWRIGHT)).toMatchObject({
    conclusion: "failed",
    passed: 11,
    failed: 2,
    skipped: 1,
    total: 14,
  })
})

it("parses cargo test", () => {
  expect(parseVerificationOutput("cargo-test", CARGO)).toMatchObject({
    conclusion: "passed",
    passed: 10,
    failed: 0,
    skipped: 2,
    total: 12,
  })
})

it("sums every cargo crate's result line", () => {
  expect(parseVerificationOutput("cargo-test", CARGO_TWO_CRATES)).toMatchObject({
    conclusion: "failed",
    passed: 10,
    failed: 2,
    skipped: 1,
    total: 13,
  })
})

describe("a `package-script` command resolves to whichever format it printed", () => {
  it.each([
    ["jest", JEST_PASS, 10],
    ["vitest", VITEST, 14],
    ["playwright", PLAYWRIGHT, 14],
    ["cargo", CARGO, 12],
  ])("%s", (_label, output, total) => {
    expect(parseVerificationOutput("package-script", output).total).toBe(total)
  })
})

describe("unparseable output is inconclusive, never green", () => {
  it.each([
    ["empty", ""],
    ["whitespace", "   \n  "],
    ["a killed process", "error Command failed with exit code 137."],
    ["an unknown reporter", "ran 10 checks, everything is fine"],
    ["a compiler error", "error[E0432]: unresolved import\nerror: could not compile"],
  ])("%s", (_label, output) => {
    const summary = parseVerificationOutput("package-script", output)
    expect(summary.conclusion).toBe("inconclusive")
    // The whole point: this must not read as a green run.
    expect(summary.conclusion).not.toBe("passed")
    expect(summary).toMatchObject({ passed: 0, failed: 0, total: 0 })
  })
})

it("scans only the tail so a huge log still finds the summary", () => {
  const noise = "x".repeat(200_000)
  expect(parseVerificationOutput("jest", `${noise}\n${JEST_PASS}`).total).toBe(10)
})

it("gives up when the summary is buried before the tail window", () => {
  const noise = "x\n".repeat(100_000)
  expect(parseVerificationOutput("jest", `${JEST_PASS}\n${noise}`).conclusion).toBe("inconclusive")
})

describe("verificationOutputText flattens tool-result shapes", () => {
  it.each([
    ["string", "hello", "hello"],
    ["text object", { text: "hello" }, "hello"],
    ["content blocks", { content: [{ text: "a" }, { text: "b" }] }, "a\nb"],
    ["array", [{ text: "a" }, "b"], "a\nb"],
    ["streams", { stdout: "out", stderr: "err" }, "out\nerr"],
  ])("%s", (_label, input, expected) => {
    expect(verificationOutputText(input)).toBe(expected)
  })

  it("returns empty text for shapes it cannot read", () => {
    expect(verificationOutputText(null)).toBe("")
    expect(verificationOutputText(42)).toBe("")
    expect(verificationOutputText({ weird: true })).toBe("")
  })
})

it("parses a real tool-result envelope end to end", () => {
  const result = { content: [{ type: "text", text: JEST_FAIL }] }
  expect(parseVerificationOutput("package-script", result)).toMatchObject({
    conclusion: "failed",
    failed: 1,
    total: 13,
  })
})
