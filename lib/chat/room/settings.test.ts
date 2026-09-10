import {
  DEFAULT_ROOM_REPLY_MODE,
  MAX_ROOM_INSTRUCTIONS_CHARS,
  ROOM_REPLY_MODES,
  buildRoomInstructionsSection,
  defaultRoomMemory,
  initialRoomMemoryFields,
  resolveRoomSettings,
  roomSettingsPatch,
} from "./settings"

const team = { kind: "team" as const, teamId: "t" }
const im = {
  kind: "direct" as const,
  platformBinding: { platform: "telegram", adapterId: "a", conversationKey: "k" } as never,
}

describe("resolveRoomSettings", () => {
  it("defaults a team room to memory on and a multi-human room to memory off", () => {
    expect(resolveRoomSettings(team)).toMatchObject({
      kind: "team",
      memory: true,
      memoryDefaulted: true,
    })
    expect(resolveRoomSettings(im)).toMatchObject({
      kind: "im",
      memory: false,
      memoryDefaulted: true,
    })
    expect(defaultRoomMemory("shared")).toBe(false)
  })

  it("reads a legacy row's memoryUse when roomSettings has no memory field", () => {
    expect(resolveRoomSettings({ ...im, memoryUse: true })).toMatchObject({
      memory: true,
      memoryDefaulted: false,
    })
  })

  it("prefers the stored room setting over the legacy switch", () => {
    expect(
      resolveRoomSettings({ ...team, memoryUse: true, roomSettings: { memory: false } })
    ).toMatchObject({ memory: false })
  })

  it("falls back to the default reply mode on an unknown value", () => {
    expect(
      resolveRoomSettings({ ...team, roomSettings: { replyMode: "loud" as never } })
    ).toMatchObject({ replyMode: DEFAULT_ROOM_REPLY_MODE })
    expect(ROOM_REPLY_MODES).toEqual(["auto", "mention_only", "asleep"])
  })

  it("trims and clamps instructions and dedupes muted ids", () => {
    const long = "x".repeat(MAX_ROOM_INSTRUCTIONS_CHARS + 10)
    const resolved = resolveRoomSettings({
      ...team,
      roomSettings: { instructions: `  ${long}  `, mutedMemberIds: ["a", "a", "", "b"] },
    })
    expect(resolved.instructions).toHaveLength(MAX_ROOM_INSTRUCTIONS_CHARS)
    expect(resolved.mutedMemberIds).toEqual(["a", "b"])
  })

  it("pins the batch 1 dormancy: replyMode and mutedMemberIds are stored, not acted on", () => {
    // The runner reads neither field until batch 3 (ADR-0177). This test exists
    // so that wiring them is a deliberate change that has to update it.
    const resolved = resolveRoomSettings({
      ...team,
      roomSettings: { replyMode: "asleep", mutedMemberIds: ["a"] },
    })
    expect(resolved.replyMode).toBe("asleep")
    expect(resolved.mutedMemberIds).toEqual(["a"])
  })
})

describe("roomSettingsPatch", () => {
  it("writes the whole object and mirrors memory onto the session switches", () => {
    expect(roomSettingsPatch({ instructions: "keep" }, { memory: false })).toEqual({
      roomSettings: { instructions: "keep", memory: false },
      memoryUse: false,
      memoryLearn: false,
    })
  })

  it("does not touch the memory switches for a non-memory change", () => {
    const patch = roomSettingsPatch(undefined, { instructions: " hi " })
    expect(patch).toEqual({ roomSettings: { instructions: "hi" } })
    expect("memoryUse" in patch).toBe(false)
  })

  it("dedupes muted ids on write", () => {
    expect(roomSettingsPatch({}, { mutedMemberIds: ["a", "a"] })).toEqual({
      roomSettings: { mutedMemberIds: ["a"] },
    })
  })
})

describe("prompt and row helpers", () => {
  it("renders an instructions section only when there is text", () => {
    expect(buildRoomInstructionsSection("   ")).toBe("")
    expect(buildRoomInstructionsSection("Be brief.")).toBe("## Room instructions\n\nBe brief.")
  })

  it("mints multi-human rooms with memory off and team rooms untouched", () => {
    expect(initialRoomMemoryFields("im")).toEqual({ memoryUse: false, memoryLearn: false })
    expect(initialRoomMemoryFields("shared")).toEqual({ memoryUse: false, memoryLearn: false })
    expect(initialRoomMemoryFields("team")).toEqual({})
    expect(initialRoomMemoryFields(null)).toEqual({})
  })
})
