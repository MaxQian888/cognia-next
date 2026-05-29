import { resolveComputerUseTarget, type ComputerUseTarget } from "@/lib/automation/sandbox-target"

const local: ComputerUseTarget = { kind: "local" }

test("undefined everywhere → local", () => {
  expect(resolveComputerUseTarget(undefined, undefined)).toEqual(local)
})

test("character remote, session unset → character wins", () => {
  expect(resolveComputerUseTarget(undefined, { connectionId: "c1" })).toEqual({
    kind: "remote",
    connectionId: "c1",
  })
})

test('session "local" overrides character remote', () => {
  expect(resolveComputerUseTarget("local", { connectionId: "c1" })).toEqual(local)
})

test("session remote overrides character", () => {
  expect(resolveComputerUseTarget({ connectionId: "s1" }, { connectionId: "c1" })).toEqual({
    kind: "remote",
    connectionId: "s1",
  })
})
