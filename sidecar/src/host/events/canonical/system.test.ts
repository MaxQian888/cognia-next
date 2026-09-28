import test from "node:test"
import assert from "node:assert/strict"
import { fromSystem } from "./system.ts"

test("unknown and prototype-named subtypes remain diagnostics", () => {
  for (const subtype of ["__proto__", "toString", "constructor", "future"]) {
    const event = { type: "system", subtype }
    assert.deepEqual(fromSystem(event), [
      { kind: "diagnostic", runtime: "claude-agent-sdk", payload: event },
    ])
  }
})
