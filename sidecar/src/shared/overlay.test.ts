import { test } from "node:test"
import assert from "node:assert/strict"

import { overlay } from "./overlay.ts"

class Counter {
  #count = 1
  label = "original"
  read(): number {
    return this.#count
  }
}

test("overrides shadow members, including symbol keys", () => {
  const tag = Symbol("tag")
  const view = overlay(new Counter(), { label: "shadowed", [tag]: "symbol" })
  assert.equal(view.label, "shadowed")
  assert.equal((view as unknown as Record<symbol, unknown>)[tag], "symbol")
})

test("an override can shadow a member with a falsy value", () => {
  const view = overlay({ links: ["a"], status: { code: 2 } }, { links: [], status: undefined })
  assert.deepEqual(view.links, [])
  assert.equal(view.status, undefined)
})

test("methods stay bound to the original, so private fields still work", () => {
  const view = overlay(new Counter(), { label: "shadowed" })
  const read = view.read
  assert.equal(read(), 1)
})

test("the original object is left untouched", () => {
  const original = new Counter()
  overlay(original, { label: "shadowed" })
  assert.equal(original.label, "original")
})
