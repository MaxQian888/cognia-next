import {
  adapterAllowsBuiltInSkill,
  adapterAllowsHostCapability,
  resolveImHostCapabilities,
  resolveRequireHitlForWrites,
} from "./permission-resolve"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

describe("IM permission resolution", () => {
  it("treats an undefined skill ceiling as unrestricted and supports family wildcards", () => {
    const skill = { id: "lark.calendar.list_events", family: "lark.calendar" }
    expect(adapterAllowsBuiltInSkill(undefined, skill)).toBe(true)
    expect(adapterAllowsBuiltInSkill({ builtInSkillCeiling: [] }, skill)).toBe(false)
    expect(adapterAllowsBuiltInSkill({ builtInSkillCeiling: ["lark.calendar.*"] }, skill)).toBe(
      true
    )
  })

  it("resolves write HITL conversation then adapter then secure default", () => {
    expect(resolveRequireHitlForWrites(undefined, undefined)).toBe(true)
    expect(resolveRequireHitlForWrites({ requireHitlForWrites: false }, undefined)).toBe(false)
    expect(
      resolveRequireHitlForWrites({ requireHitlForWrites: false }, { requireHitlForWrites: true })
    ).toBe(true)
  })

  it("uses adapter host capabilities as ceilings, never as high-risk defaults", () => {
    // Annotated rather than `as const`: the row field is a mutable array, and a
    // readonly tuple is not assignable to it.
    const adapter: Pick<AdapterInstanceRow, "hostCapabilityCeiling"> = {
      hostCapabilityCeiling: ["computer_use", "ocr"],
    }
    expect(adapterAllowsHostCapability(adapter, "goal_driving")).toBe(false)
    expect(
      resolveImHostCapabilities({
        adapter,
        override: { allowComputerUse: true, allowOcr: undefined, allowGoalDriving: true },
        characterComputerUseEnabled: true,
      })
    ).toEqual({
      computer_use: true,
      ocr: true,
      goal_driving: false,
      schedule_tools: false,
    })
  })
})
