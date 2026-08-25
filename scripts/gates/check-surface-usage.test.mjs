import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"

import { scanSource, compare, BASELINE_FILE } from "./check-surface-usage.mjs"

describe("scanSource", () => {
  test("flags a div carrying radius + border + background", () => {
    assert.equal(scanSource('<div className="rounded-lg border bg-card p-3" />'), 1)
  })

  test("ignores a container missing any one of the three", () => {
    assert.equal(scanSource('<div className="rounded-lg border p-3" />'), 0)
    assert.equal(scanSource('<div className="rounded-lg bg-card p-3" />'), 0)
    assert.equal(scanSource('<div className="border bg-card p-3" />'), 0)
  })

  test("does not care what order the three appear in", () => {
    assert.equal(scanSource('<div className="bg-muted/40 p-2 border rounded-md" />'), 1)
  })

  test("flags radius steps a style pack cannot reach", () => {
    // rounded-2xl / 3xl / arbitrary resolve from Tailwind's static scale, not
    // from --radius, so they survive a pack untouched.
    assert.equal(scanSource('className="rounded-2xl"'), 1)
    assert.equal(scanSource('className="rounded-3xl"'), 1)
    assert.equal(scanSource('className="rounded-[18px]"'), 1)
  })

  test("accepts every step that does track --radius", () => {
    for (const cls of [
      "rounded-sm",
      "rounded-md",
      "rounded-lg",
      "rounded-xl",
      "rounded-control",
      "rounded-panel",
      "rounded-stage",
      "rounded-pill",
      "rounded-none",
    ]) {
      assert.equal(scanSource(`className="${cls}"`), 0, cls)
    }
  })

  test("flags raw shadow utilities but not the semantic ramp", () => {
    assert.equal(scanSource('className="shadow-md"'), 1)
    assert.equal(scanSource('className="shadow-none"'), 0)
    assert.equal(scanSource("<Surface elevation={2} />"), 0)
    assert.equal(scanSource('<div data-elevation="2" />'), 0)
  })

  /**
   * The gate's own docstring quotes `shadow-sm` and `rounded-2xl` to explain
   * why they are refused. Counting matches inside comments made documenting the
   * rule a violation of it.
   */
  test("ignores matches inside comments", () => {
    assert.equal(scanSource('// className="rounded-2xl shadow-lg"'), 0)
    assert.equal(scanSource("/* a rounded-2xl panel: rounded-md border bg-card */"), 0)
    assert.equal(scanSource("/**\n * quoting `shadow-sm` in a doc comment\n */\nconst x = 1"), 0)
    // ...but a real occurrence on the same line as a trailing comment still counts.
    assert.equal(scanSource('className="shadow-md" // fine'), 1)
  })

  test("counts every occurrence, so a file cannot hide one behind another", () => {
    assert.equal(scanSource('className="rounded-2xl" ... className="shadow-lg"'), 2)
  })
})

describe("compare", () => {
  test("passes when a file stays at its baseline", () => {
    const { regressions } = compare({ "a.tsx": 3 }, { "a.tsx": 3 })
    assert.deepEqual(regressions, [])
  })

  test("fails when a file grows", () => {
    const { regressions } = compare({ "a.tsx": 4 }, { "a.tsx": 3 })
    assert.equal(regressions.length, 1)
    assert.match(regressions[0], /baseline allows 3/)
  })

  test("fails on a brand-new offending file", () => {
    const { regressions } = compare({ "b.tsx": 1 }, {})
    assert.match(regressions[0], /new file/)
  })

  /**
   * Per-file counts, not a total: paying debt down in one file must not buy
   * room for a new panel somewhere else.
   */
  test("does not let one file's improvement fund another's regression", () => {
    const { regressions } = compare({ "a.tsx": 1, "b.tsx": 5 }, { "a.tsx": 4, "b.tsx": 4 })
    assert.equal(regressions.length, 1)
    assert.match(regressions[0], /^b\.tsx/)
  })

  test("reports improvements so the baseline can be tightened", () => {
    const { improvements } = compare({ "a.tsx": 1 }, { "a.tsx": 4, "gone.tsx": 2 })
    assert.equal(improvements.length, 2)
  })
})

describe("baseline", () => {
  test("exists and is a path → count map", () => {
    assert.ok(existsSync(BASELINE_FILE), "run: pnpm audit:surfaces -- --write-baseline")
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
    const entries = Object.entries(baseline)
    // Guard the guard: an empty baseline would make every comparison vacuous.
    assert.ok(entries.length > 100, `expected a real baseline, got ${entries.length} entries`)
    for (const [file, count] of entries) {
      assert.match(file, /\.tsx$/)
      assert.ok(Number.isInteger(count) && count > 0, `${file}: ${count}`)
    }
  })

  test("never records the excluded vendored roots", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
    for (const file of Object.keys(baseline)) {
      assert.ok(!file.startsWith("components/ui/"), file)
      assert.ok(!file.startsWith("components/ai-elements/"), file)
    }
  })
})
