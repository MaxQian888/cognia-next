import { isLocallyOrchestratedRoom, isMultiHumanRoom, roomKindOf } from "./kind"

const binding = { platform: "telegram", adapterId: "a", conversationKey: "k" } as never
const collaboration = {
  orgId: "org",
  workspaceId: "ws",
  sessionId: "s",
  policyRevision: 1,
  syncCursor: 0,
}

describe("roomKindOf", () => {
  it("is null for a plain direct conversation", () => {
    expect(roomKindOf({ kind: "direct" })).toBeNull()
    expect(roomKindOf(undefined)).toBeNull()
  })

  it("reads a character team off kind + teamId", () => {
    expect(roomKindOf({ kind: "team", teamId: "t" })).toBe("team")
    expect(roomKindOf({ kind: "team" })).toBeNull()
  })

  it("reads an IM group off the platform binding", () => {
    expect(roomKindOf({ kind: "direct", platformBinding: binding })).toBe("im")
  })

  it("lets a shared binding win over every other column", () => {
    expect(roomKindOf({ kind: "team", teamId: "t", collaboration, platformBinding: binding })).toBe(
      "shared"
    )
  })
})

describe("room predicates", () => {
  it("only a team room is orchestrated locally", () => {
    expect(isLocallyOrchestratedRoom({ kind: "team", teamId: "t" })).toBe(true)
    expect(isLocallyOrchestratedRoom({ kind: "team", teamId: "t", collaboration })).toBe(false)
    expect(isLocallyOrchestratedRoom({ kind: "direct", platformBinding: binding })).toBe(false)
  })

  it("shared and IM rooms can hold more than one human", () => {
    expect(isMultiHumanRoom("shared")).toBe(true)
    expect(isMultiHumanRoom("im")).toBe(true)
    expect(isMultiHumanRoom("team")).toBe(false)
    expect(isMultiHumanRoom(null)).toBe(false)
  })
})
