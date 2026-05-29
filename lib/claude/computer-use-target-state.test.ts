import {
  setActiveComputerUseTarget,
  getActiveComputerUseTarget,
  clearActiveComputerUseTarget,
} from "@/lib/claude/computer-use-target-state"

test("defaults to local when unset", () => {
  expect(getActiveComputerUseTarget("nope")).toEqual({ kind: "local" })
})

test("defaults to local for undefined session id", () => {
  expect(getActiveComputerUseTarget(undefined)).toEqual({ kind: "local" })
})

test("stores and reads a remote target per session", () => {
  setActiveComputerUseTarget("s1", { kind: "remote", connectionId: "c1" })
  expect(getActiveComputerUseTarget("s1")).toEqual({ kind: "remote", connectionId: "c1" })
})

test("clear removes the stashed target", () => {
  setActiveComputerUseTarget("s2", { kind: "remote", connectionId: "c2" })
  clearActiveComputerUseTarget("s2")
  expect(getActiveComputerUseTarget("s2")).toEqual({ kind: "local" })
})
