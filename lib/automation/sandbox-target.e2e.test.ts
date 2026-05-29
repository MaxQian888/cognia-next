/**
 * Wiring test (ADR-0020 remote-target): the chat-path chain that turns a
 * session/character `computerUseTarget` into the `sandboxConnectionId` the Rust
 * `cua_route` layer reads. Exercises the pure resolver + the per-session stash
 * the computer-use plugin executor reads back, end-to-end.
 */
import { resolveComputerUseTarget } from "@/lib/automation/sandbox-target"
import {
  setActiveComputerUseTarget,
  getActiveComputerUseTarget,
  clearActiveComputerUseTarget,
} from "@/lib/claude/computer-use-target-state"

test("session remote target flows through resolve + stash to the executor read", () => {
  const sessionId = "sess-remote"
  // resolveSendOptions resolves (session → character → local) at send time…
  const resolved = resolveComputerUseTarget({ connectionId: "conn-9" }, undefined)
  setActiveComputerUseTarget(sessionId, resolved)
  // …and buildChatCallContext reads it back to stamp sandboxConnectionId.
  const fromExecutor = getActiveComputerUseTarget(sessionId)
  expect(fromExecutor).toEqual({ kind: "remote", connectionId: "conn-9" })
})

test("disabling computer use clears the stash so the host is used again", () => {
  const sessionId = "sess-cleared"
  setActiveComputerUseTarget(sessionId, { kind: "remote", connectionId: "conn-1" })
  clearActiveComputerUseTarget(sessionId)
  expect(getActiveComputerUseTarget(sessionId)).toEqual({ kind: "local" })
})

test("session local override wins over a remote character default", () => {
  const resolved = resolveComputerUseTarget("local", { connectionId: "conn-char" })
  expect(resolved).toEqual({ kind: "local" })
})
