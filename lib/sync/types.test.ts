import type { SyncOutcome, SyncableTable } from "./types"

function appliedRows(outcome: SyncOutcome): number {
  return outcome.ok ? outcome.result.applied : 0
}

it("keeps successful and failed sync outcomes safely discriminated", () => {
  const table = "templateDefinitions" satisfies SyncableTable
  const success = {
    ok: true,
    result: { table, applied: 3, nextSince: 42 },
  } satisfies SyncOutcome
  const failure = {
    ok: false,
    failure: { table, reason: "transport", message: "offline" },
  } satisfies SyncOutcome

  expect(appliedRows(success)).toBe(3)
  expect(appliedRows(failure)).toBe(0)
})
