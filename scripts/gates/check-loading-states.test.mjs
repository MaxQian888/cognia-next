import { strict as assert } from "node:assert"
import { test } from "node:test"

import { findOffences } from "./check-loading-states.mjs"

test("flags a lucide loader spun by hand", () => {
  const src = `<Loader2 className="h-4 w-4 animate-spin" />`
  assert.equal(findOffences(src).spinner, true)
})

test("flags every lucide loader alias", () => {
  for (const glyph of ["Loader2Icon", "LoaderIcon", "LoaderCircle"]) {
    assert.equal(
      findOffences(`<${glyph} className="animate-spin" />`).spinner,
      true,
      `${glyph} should be flagged`
    )
  }
})

test("accepts a loader routed through the shared primitive", () => {
  assert.equal(findOffences(`<Spinner className="size-4" />`).spinner, false)
})

test("accepts a spinning glyph that is not a loader", () => {
  // A refresh icon spun on demand is an action affordance, not a loading state.
  assert.equal(findOffences(`<RefreshCwIcon className="animate-spin" />`).spinner, false)
})

test("flags a hand-rolled skeleton block", () => {
  const src = `<div className="my-3 h-32 animate-pulse rounded bg-muted" />`
  assert.equal(findOffences(src).skeleton, true)
})

test("flags a hand-rolled skeleton that fills its container", () => {
  assert.equal(
    findOffences(`<div className="absolute inset-0 animate-pulse bg-muted/40" />`).skeleton,
    true
  )
})

test("does NOT flag a pulsing running-state dot", () => {
  // This is the distinction the gate exists to make. A pulsing dot means "this
  // is running"; rewriting it as a Skeleton would be a bug, not a fix.
  const src = `<span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />`
  assert.equal(findOffences(src).skeleton, false)
})

test("does NOT flag a pulsing icon", () => {
  assert.equal(findOffences(`<ClockIcon className="size-3.5 animate-pulse" />`).skeleton, false)
})

test("does NOT flag a streaming caret", () => {
  assert.equal(findOffences(`<span className="animate-pulse">▌</span>`).skeleton, false)
})

test("accepts a placeholder routed through the shared primitive", () => {
  assert.equal(findOffences(`<Skeleton className="my-3 h-32" />`).skeleton, false)
})

test("does not confuse a pulse and a background on separate elements", () => {
  // Matching per-line rather than per-file keeps an unrelated `bg-muted`
  // wrapper from turning a nearby pulsing dot into a false positive.
  const src = [
    `<div className="bg-muted rounded">`,
    `  <span className="size-2 rounded-full bg-primary animate-pulse" />`,
    `</div>`,
  ].join("\n")
  assert.equal(findOffences(src).skeleton, false)
})
