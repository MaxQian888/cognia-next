import {
  __resetForTesting,
  __snapshotForTesting,
  clearAllSessionGrants,
  clearSessionGrants,
  hasSessionGrant,
  recordSessionGrant,
} from "./computer-use-session-grants"

beforeEach(() => {
  __resetForTesting()
})

describe("computer-use-session-grants", () => {
  it("returns false for any (sessionId, toolName) before a grant is recorded", () => {
    expect(hasSessionGrant("s1", "computer_use")).toBe(false)
  })

  it("records and recalls a single grant", () => {
    recordSessionGrant("s1", "computer_use")
    expect(hasSessionGrant("s1", "computer_use")).toBe(true)
  })

  it("keeps grants scoped to the recording session", () => {
    recordSessionGrant("s1", "computer_use")
    expect(hasSessionGrant("s2", "computer_use")).toBe(false)
  })

  it("keeps grants scoped to the recorded tool name", () => {
    recordSessionGrant("s1", "computer_use")
    expect(hasSessionGrant("s1", "bash")).toBe(false)
  })

  it("recordSessionGrant is idempotent", () => {
    recordSessionGrant("s1", "computer_use")
    recordSessionGrant("s1", "computer_use")
    expect(__snapshotForTesting()).toEqual({ s1: ["computer_use"] })
  })

  it("clearSessionGrants drops every grant for the given session", () => {
    recordSessionGrant("s1", "computer_use")
    recordSessionGrant("s1", "bash")
    recordSessionGrant("s2", "computer_use")
    clearSessionGrants("s1")
    expect(hasSessionGrant("s1", "computer_use")).toBe(false)
    expect(hasSessionGrant("s2", "computer_use")).toBe(true)
  })

  it("clearAllSessionGrants wipes every session", () => {
    recordSessionGrant("s1", "computer_use")
    recordSessionGrant("s2", "bash")
    clearAllSessionGrants()
    expect(__snapshotForTesting()).toEqual({})
  })

  it("ignores empty session id or tool name", () => {
    recordSessionGrant("", "computer_use")
    recordSessionGrant("s1", "")
    expect(__snapshotForTesting()).toEqual({})
    expect(hasSessionGrant("", "computer_use")).toBe(false)
    expect(hasSessionGrant("s1", "")).toBe(false)
  })
})
