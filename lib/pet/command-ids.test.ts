import { PET_INTERACTION_COMMAND_IDS, PET_WINDOW_COMMAND_ID } from "./command-ids"

describe("pet command ids", () => {
  it("name the window toggle the global hotkey and tray dispatch to", () => {
    expect(PET_WINDOW_COMMAND_ID).toBe("pet.toggle-window")
  })

  it("list the six nurture commands once each, all under the pet namespace", () => {
    expect(PET_INTERACTION_COMMAND_IDS).toEqual([
      "pet.feed",
      "pet.play",
      "pet.pet",
      "pet.sleep",
      "pet.clean",
      "pet.treat",
    ])
    expect(new Set(PET_INTERACTION_COMMAND_IDS).size).toBe(PET_INTERACTION_COMMAND_IDS.length)
    expect(PET_INTERACTION_COMMAND_IDS).not.toContain(PET_WINDOW_COMMAND_ID)
  })
})
