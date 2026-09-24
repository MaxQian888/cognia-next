import { isRoutableSession, isTurnRoute, readTurnRoute } from "./types"

const codex = { target: { kind: "runtime", runtime: "codex" }, handle: "codex", label: "codex" }
const member = {
  target: { kind: "squadMember", squadId: "s1", teammateId: "tm-1" },
  handle: "critic",
  label: "Critic",
}

describe("isTurnRoute", () => {
  it("accepts both target kinds", () => {
    expect(isTurnRoute(codex)).toBe(true)
    expect(isTurnRoute(member)).toBe(true)
  })

  it("rejects an unknown runtime, a half-made member and missing strings", () => {
    expect(isTurnRoute({ ...codex, target: { kind: "runtime", runtime: "gemini" } })).toBe(false)
    expect(isTurnRoute({ ...member, target: { kind: "squadMember", squadId: "s1" } })).toBe(false)
    expect(isTurnRoute({ ...codex, handle: "" })).toBe(false)
    expect(isTurnRoute({ ...codex, label: undefined })).toBe(false)
    expect(isTurnRoute({ ...codex, target: { kind: "other" } })).toBe(false)
    expect(isTurnRoute({ handle: "codex", label: "codex" })).toBe(false)
    expect(isTurnRoute(null)).toBe(false)
    expect(isTurnRoute("codex")).toBe(false)
  })
})

describe("readTurnRoute", () => {
  it("reads the route a user message was sent with", () => {
    expect(readTurnRoute({ turnRoute: codex, mentions: [] })).toEqual(codex)
  })

  it("reads a malformed or absent route as no route", () => {
    expect(readTurnRoute({ turnRoute: { handle: "codex" } })).toBeNull()
    expect(readTurnRoute({})).toBeNull()
    expect(readTurnRoute(undefined)).toBeNull()
    expect(readTurnRoute("turnRoute")).toBeNull()
  })
})

describe("isRoutableSession", () => {
  it("routes the new-chat composer and a plain direct chat", () => {
    expect(isRoutableSession(null)).toBe(true)
    expect(isRoutableSession(undefined)).toBe(true)
    expect(isRoutableSession({ kind: "direct" })).toBe(true)
    // A row from before `kind` existed is a direct chat.
    expect(isRoutableSession({})).toBe(true)
  })

  it("never routes a team room, a shared transcript, an IM conversation or a panel", () => {
    expect(isRoutableSession({ kind: "team" })).toBe(false)
    expect(isRoutableSession({ kind: "workflow-editor" })).toBe(false)
    expect(isRoutableSession({ kind: "resource-workbench" })).toBe(false)
    expect(isRoutableSession({ kind: "direct", collaboration: {} as never })).toBe(false)
    expect(isRoutableSession({ kind: "direct", platformBinding: {} as never })).toBe(false)
  })
})
