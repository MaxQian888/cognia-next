import { completenessFor, projectRoomParticipants } from "./participants"

const alice = { id: "c-alice", name: "Alice" }
const bob = { id: "c-bob", name: "Bob" }

describe("projectRoomParticipants", () => {
  it("declares a team's members with roles before anyone has spoken", () => {
    const projection = projectRoomParticipants({
      kind: "team",
      characters: [alice, bob],
      members: [{ characterId: "c-alice", role: "Critic" }, { characterId: "c-bob" }],
    })
    expect(projection.completeness).toBe("full")
    expect(projection.participants.map((p) => [p.speaker.id, p.speaker.kind, p.role])).toEqual([
      ["c-alice", "agent", "Critic"],
      ["c-bob", "agent", undefined],
    ])
    expect([...projection.declaredIds]).toEqual(["c-alice", "c-bob"])
  })

  it("keeps the declared row when a member has also spoken, and adds strangers", () => {
    const projection = projectRoomParticipants({
      kind: "team",
      characters: [alice],
      members: [{ characterId: "c-alice", role: "Critic" }],
      messages: [
        { role: "assistant", senderId: "c-alice" },
        {
          role: "user",
          metadata: { platformMessage: { sender: { id: "tg:9", displayName: "Zed" } } },
        },
      ],
      ctx: { characterNameById: new Map([["c-alice", "Alice"]]) },
    })
    expect(projection.participants.map((p) => [p.speaker.id, p.role])).toEqual([
      ["c-alice", "Critic"],
      ["tg:9", undefined],
    ])
  })

  it("reads a shared room's roster from memberships and marks guests", () => {
    const projection = projectRoomParticipants({
      kind: "shared",
      memberships: [
        { userId: "usr_1", role: "owner", guest: false, displayName: "Ada" },
        { userId: "usr_2", role: "viewer", guest: true },
      ],
      selfId: "usr_1",
    })
    expect(projection.completeness).toBe("full")
    expect(projection.participants.map((p) => [p.speaker.kind, p.role, p.isSelf ?? false])).toEqual(
      [
        ["human", "owner", true],
        ["guest", "viewer", false],
      ]
    )
  })

  it("has only observed speakers for an IM group until an adapter reads members", () => {
    const projection = projectRoomParticipants({
      kind: "im",
      messages: [
        {
          role: "user",
          metadata: { platformMessage: { sender: { id: "tg:1", displayName: "A" } } },
        },
        {
          role: "user",
          metadata: { platformMessage: { sender: { id: "tg:2", displayName: "B" } } },
        },
      ],
    })
    expect(projection.completeness).toBe("observed")
    expect(projection.declaredIds.size).toBe(0)
    expect(projection.participants.map((p) => p.speaker.id)).toEqual(["tg:2", "tg:1"])
  })

  it("never claims a full roster it did not receive", () => {
    expect(completenessFor("team", 0)).toBe("observed")
    expect(completenessFor("shared", 2)).toBe("full")
    expect(completenessFor("im", 5)).toBe("observed")
    expect(completenessFor(null, 0)).toBe("observed")
  })
})
