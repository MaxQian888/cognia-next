import {
  MAX_ROSTER_PARTICIPANTS,
  buildRoomRosterSection,
  collectRoomParticipants,
  mergeRoomParticipants,
  type RoomParticipant,
} from "./room-roster"
import { resolveMessageSpeaker, type SpeakerSource } from "./speaker"

function imMessage(id: string, displayName?: string): SpeakerSource {
  return {
    role: "user",
    metadata: { platformMessage: { sender: { id, ...(displayName ? { displayName } : {}) } } },
  }
}

function participant(id: string, displayName: string, extra: Partial<RoomParticipant> = {}) {
  return { speaker: resolveMessageSpeaker(imMessage(id, displayName))!, ...extra }
}

describe("collectRoomParticipants", () => {
  it("deduplicates by speaker id", () => {
    const found = collectRoomParticipants([
      imMessage("tg:1", "Alice"),
      imMessage("tg:2", "Bob"),
      imMessage("tg:1", "Alice"),
    ])
    expect(found).toHaveLength(2)
    expect(found.map((p) => p.speaker.label).sort()).toEqual(["Alice", "Bob"])
  })

  it("orders newest first, so a capped roster keeps whoever just spoke", () => {
    const found = collectRoomParticipants([
      imMessage("tg:1", "Alice"),
      imMessage("tg:2", "Bob"),
      imMessage("tg:3", "Cara"),
    ])
    expect(found.map((p) => p.speaker.label)).toEqual(["Cara", "Bob", "Alice"])
  })

  it("skips messages with no attribution", () => {
    expect(collectRoomParticipants([{ role: "user" }, { role: "assistant" }])).toEqual([])
  })

  it("resolves team members through the character map", () => {
    const found = collectRoomParticipants([{ role: "assistant", senderId: "char_a" }], {
      characterNameById: new Map([["char_a", "Ana"]]),
    })
    expect(found[0].speaker.label).toBe("Ana")
    expect(found[0].speaker.kind).toBe("agent")
  })
})

describe("mergeRoomParticipants", () => {
  it("keeps the declared entry, which carries the role and the self marker", () => {
    const declared = [participant("char_a", "Ana", { role: "Critic", isSelf: true })]
    const observed = [participant("char_a", "Ana"), participant("tg:9", "Bob")]
    const merged = mergeRoomParticipants(declared, observed)
    expect(merged).toHaveLength(2)
    expect(merged[0].role).toBe("Critic")
    expect(merged[0].isSelf).toBe(true)
  })

  it("keeps a declared member who has not spoken yet", () => {
    const merged = mergeRoomParticipants([participant("char_quiet", "Quiet")], [])
    expect(merged.map((p) => p.speaker.label)).toEqual(["Quiet"])
  })
})

describe("buildRoomRosterSection", () => {
  it("renders nothing for a room that is not one", () => {
    expect(buildRoomRosterSection([])).toBe("")
    expect(buildRoomRosterSection([participant("tg:1", "Alice")])).toBe("")
  })

  it("names each participant with its class", () => {
    const section = buildRoomRosterSection([
      participant("tg:1", "Alice"),
      {
        speaker: resolveMessageSpeaker({ role: "assistant", senderId: "char_a" })!,
        role: "Critic",
      },
    ])
    expect(section).toContain("## Who is in this room")
    expect(section).toContain("Alice")
    expect(section).toContain("(human)")
    expect(section).toContain("(agent, Critic)")
  })

  it("marks the participant the prompt is being built for", () => {
    const section = buildRoomRosterSection([
      participant("tg:1", "Alice"),
      participant("tg:2", "Bob", { isSelf: true }),
    ])
    expect(section).toContain("you)")
  })

  it("caps the list and counts the rest, so a large channel is a fixed cost", () => {
    const many = Array.from({ length: MAX_ROSTER_PARTICIPANTS + 7 }, (_, i) =>
      participant(`tg:${i}`, `Person ${i}`)
    )
    const section = buildRoomRosterSection(many)
    const bullets = section.split("\n").filter((line) => line.startsWith("- "))
    expect(bullets).toHaveLength(MAX_ROSTER_PARTICIPANTS + 1)
    expect(section).toContain("and 7 more participants")
  })

  it("uses the singular when exactly one participant is left over", () => {
    const many = Array.from({ length: MAX_ROSTER_PARTICIPANTS + 1 }, (_, i) =>
      participant(`tg:${i}`, `Person ${i}`)
    )
    expect(buildRoomRosterSection(many)).toContain("and 1 more participant\n")
  })
})
