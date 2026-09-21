import { parseJUnitReport } from "./junit-report"

function ok(xml: string) {
  const parsed = parseJUnitReport(xml)
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`)
  return parsed.report
}

describe("parseJUnitReport", () => {
  it("reads suites and cases with failures, errors and skips", () => {
    const report = ok(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="4" failures="1" errors="1" skipped="1">
  <testsuite name="users" tests="4">
    <testcase name="lists" classname="users.List" file="src/users/list.test.ts" time="0.25"/>
    <testcase name="race" classname="users.List"><failure message="expected 2 rows">stack…</failure></testcase>
    <testcase name="boom" classname="users.List"><error type="TypeError">x is undefined</error></testcase>
    <testcase name="later" classname="users.List"><skipped/></testcase>
    <system-out>noise</system-out>
  </testsuite>
</testsuites>`)
    expect(report.kind).toBe("junit")
    expect(report.totals).toEqual({ discovered: 4, passed: 1, failed: 1, errored: 1, skipped: 1 })
    expect(report.declared).toEqual({ tests: 4, failures: 1, errors: 1, skipped: 1 })
    expect(report.cases[0]).toEqual({
      id: "users.List::lists",
      name: "lists",
      fullName: "lists",
      scope: "users.List",
      file: "src/users/list.test.ts",
      className: "users.List",
      status: "passed",
      message: null,
      durationMs: 250,
    })
    expect(report.cases[1]).toMatchObject({ status: "failed", message: "expected 2 rows" })
    expect(report.cases[2]).toMatchObject({ status: "error", message: "x is undefined" })
    expect(report.cases[3]).toMatchObject({ status: "skipped", message: null })
    expect(report.suiteErrors).toEqual([])
  })

  it("accepts a lone <testsuite> root, nested suites and suite-level errors", () => {
    const report = ok(`<testsuite name="root" tests="2">
  <testsuite name="inner">
    <testcase name="a"/>
  </testsuite>
  <testcase name="b"/>
  <error message="fixture failed to load"/>
</testsuite>`)
    expect(report.cases.map((c) => [c.id, c.status])).toEqual([
      ["root inner::a", "passed"],
      ["root::b", "passed"],
    ])
    expect(report.suiteErrors).toEqual(["root: fixture failed to load"])
    expect(report.declared?.tests).toBe(2)
  })

  it("sums the top-level suites when the root states no totals, and leaves unknown totals null", () => {
    const summed = ok(
      `<testsuites><testsuite name="a" tests="1" failures="0" errors="0" skipped="0"><testcase name="x"/></testsuite><testsuite name="b" tests="2" failures="1" errors="0" skipped="0"><testcase name="y"/><testcase name="z"><failure/></testcase></testsuite></testsuites>`
    )
    expect(summed.declared).toEqual({ tests: 3, failures: 1, errors: 0, skipped: 0 })
    const partial = ok(
      `<testsuites><testsuite name="a" tests="1"><testcase name="x"/></testsuite><testsuite name="b"><testcase name="y"/></testsuite></testsuites>`
    )
    expect(partial.declared).toBeNull()
    const none = ok(`<testsuites/>`)
    expect(none.declared).toBeNull()
    expect(none.totals.discovered).toBe(0)
    const bad = ok(
      `<testsuite name="n" tests="many" time="soon"><testcase name="t" time="x"/></testsuite>`
    )
    expect(bad.declared).toBeNull()
    expect(bad.cases[0].durationMs).toBeNull()
  })

  it("names an unnamed case and scopes a case with no class by its suite", () => {
    const report = ok(`<testsuite><testcase/><testcase name="n"/></testsuite>`)
    expect(report.cases.map((c) => c.id)).toEqual(["(unnamed case 1)", "n"])
    expect(report.cases[1].scope).toBeNull()
  })

  it("caps a long failure message", () => {
    const report = ok(
      `<testsuite name="s"><testcase name="t"><failure>${"x".repeat(5_000)}</failure></testcase></testsuite>`
    )
    expect(report.cases[0].message?.length).toBe(2_001)
  })

  it("refuses what it cannot read instead of guessing", () => {
    expect(parseJUnitReport("   ")).toMatchObject({ ok: false, code: "REPORT_EMPTY" })
    expect(parseJUnitReport("<testsuites><testsuite></testsuites>")).toMatchObject({
      ok: false,
      code: "REPORT_MALFORMED",
    })
    expect(parseJUnitReport("not xml at all")).toMatchObject({
      ok: false,
      code: "REPORT_MALFORMED",
    })
    expect(parseJUnitReport("<html><body/></html>")).toMatchObject({
      ok: false,
      code: "REPORT_UNSUPPORTED",
    })
    expect(parseJUnitReport("<testsuite/>", { maxBytes: 4 })).toMatchObject({
      ok: false,
      code: "REPORT_TOO_LARGE",
    })
  })

  it("never expands a DTD's entities or fetches an external one", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><testsuites>&lol2;</testsuites>`
    expect(parseJUnitReport(bomb)).toMatchObject({ ok: false, code: "REPORT_MALFORMED" })
    const xxe = `<?xml version="1.0"?><!DOCTYPE t [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><testsuite name="&xxe;"/>`
    expect(parseJUnitReport(xxe)).toMatchObject({ ok: false, code: "REPORT_MALFORMED" })
  })
})
