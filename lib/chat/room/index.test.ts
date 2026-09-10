import * as room from "./index"

describe("lib/chat/room barrel", () => {
  it("exports the projection, the settings resolver and the kind reader", () => {
    expect(typeof room.projectRoomParticipants).toBe("function")
    expect(typeof room.resolveRoomSettings).toBe("function")
    expect(typeof room.roomSettingsPatch).toBe("function")
    expect(typeof room.roomKindOf).toBe("function")
    expect(typeof room.buildRoomInstructionsSection).toBe("function")
  })
})
