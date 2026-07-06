import { RADAR_SYSTEM_PROMPT, buildRadarUserMessage } from "./prompts"
import type { RadarDataItem } from "@/types/radar"

describe("RADAR_SYSTEM_PROMPT", () => {
  it("demands JSON-only output with the expected fields", () => {
    expect(RADAR_SYSTEM_PROMPT).toContain("verdict")
    expect(RADAR_SYSTEM_PROMPT).toContain("graveyard")
    expect(RADAR_SYSTEM_PROMPT).toContain("JSON")
  })
})

describe("buildRadarUserMessage", () => {
  it("numbers items 0-based with source + date", () => {
    const items: RadarDataItem[] = [
      { id: "a", text: "first thing", source: "memory", at: 0 },
      { id: "b", text: "second thing", source: "capture", at: 0 },
    ]
    const msg = buildRadarUserMessage(items, "en")
    expect(msg).toContain("[0] (memory, 1970-01-01) first thing")
    expect(msg).toContain("[1] (capture, 1970-01-01) second thing")
    expect(msg).toContain("UI locale: en")
    expect(msg).toContain("2 recent items")
  })
})
