import { stageScale, isEggStage } from "./stage-visual"
import type { PetStage } from "@/types/pet"

const STAGES: PetStage[] = ["egg", "baby", "juvenile", "adult", "elder"]

describe("stageScale", () => {
  it("returns a positive scale for every stage and grows monotonically baby→elder", () => {
    for (const s of STAGES) expect(stageScale(s)).toBeGreaterThan(0)
    expect(stageScale("baby")).toBeLessThan(stageScale("juvenile"))
    expect(stageScale("juvenile")).toBeLessThan(stageScale("adult"))
    expect(stageScale("adult")).toBeLessThan(stageScale("elder"))
  })
})

describe("isEggStage", () => {
  it("is true only for egg", () => {
    expect(isEggStage("egg")).toBe(true)
    expect(isEggStage("baby")).toBe(false)
    expect(isEggStage("elder")).toBe(false)
  })
})
