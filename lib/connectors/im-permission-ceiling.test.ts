import {
  deriveImPermissionCeiling,
  IM_OCR_TOOL_NAMES,
  IM_SCHEDULER_TOOL_NAMES,
} from "./im-permission-ceiling"

const adapter = {
  id: "adapter_1",
  platform: "telegram",
  accountLabel: "Bot",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
} as const

describe("deriveImPermissionCeiling", () => {
  it("denies skills removed by any IM manifest gate, including nested aliases", () => {
    const result = deriveImPermissionCeiling({
      adapter,
      override: null,
      target: "team",
      allBuiltInSkills: [{ mcpToolName: "mail.send" }, { mcpToolName: "calendar.list" }],
      allowedBuiltInToolNames: new Set(["calendar.list"]),
    })

    expect(result.disallowedTools).toEqual(
      expect.arrayContaining(["mail.send", "mcp__cognia-builtin-skills__mail.send"])
    )
    expect(result.disallowedTools).not.toContain("calendar.list")
  })

  it("requires explicit conversation grants for high-risk host capabilities", () => {
    const result = deriveImPermissionCeiling({
      adapter,
      override: null,
      target: "workflow",
      allBuiltInSkills: [],
      allowedBuiltInToolNames: new Set(),
    })

    expect(result.disallowedTools).toEqual(
      expect.arrayContaining([...IM_SCHEDULER_TOOL_NAMES, "perform_action"])
    )
    expect(result.disallowedTools).not.toEqual(expect.arrayContaining([...IM_OCR_TOOL_NAMES]))
  })

  it("lets the adapter ceiling restrict OCR and never lets it grant Computer Use", () => {
    const result = deriveImPermissionCeiling({
      adapter: { ...adapter, hostCapabilityCeiling: ["computer_use"] },
      override: { conversationKey: "c", allowComputerUse: true, allowOcr: true },
      target: "direct",
      character: { enableComputerUse: false },
      allBuiltInSkills: [],
      allowedBuiltInToolNames: new Set(),
    })

    expect(result.disallowedTools).toEqual(
      expect.arrayContaining(["perform_action", ...IM_OCR_TOOL_NAMES])
    )
  })
})
