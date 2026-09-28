import test from "node:test"
import assert from "node:assert/strict"
import { UNCAUGHT_ERROR_BUDGET, createUncaughtErrorGuard } from "./lifecycle.ts"

test("the process guard logs every escape and exits only past the budget", () => {
  const exits: number[] = []
  const logged: string[][] = []
  let now = 0
  const guard = createUncaughtErrorGuard({
    log: (level, line) => logged.push([level, line]),
    exit: (code) => exits.push(code),
    now: () => now,
  })
  for (let i = 0; i < UNCAUGHT_ERROR_BUDGET; i += 1) guard("uncaughtException", new Error("e"))
  assert.equal(exits.length, 0, "within budget the host keeps serving")
  assert.equal(logged.length, UNCAUGHT_ERROR_BUDGET)
  guard("unhandledRejection", new Error("one too many"))
  assert.deepEqual(exits, [1])
  // A new window resets the count.
  const quiet = createUncaughtErrorGuard({
    log: () => {},
    exit: (code) => exits.push(code),
    now: () => now,
  })
  for (let i = 0; i < UNCAUGHT_ERROR_BUDGET; i += 1) quiet("uncaughtException", new Error("e"))
  now += 61_000
  quiet("uncaughtException", new Error("later"))
  assert.deepEqual(exits, [1], "an error in a fresh window starts a fresh count")
})
