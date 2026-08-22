import {
  deriveImPermissionCeiling,
  IM_OCR_TOOL_NAMES,
  IM_SCHEDULER_TOOL_NAMES,
} from "./im-permission-ceiling"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

// A real row, not a shorthand. `platform` / `accountLabel` were never fields on
// `AdapterInstanceRow` (they are `type` / `displayName`), and `as const` kept the
// fixture from ever being checked against the type it stands in for.
const adapter: AdapterInstanceRow = {
  id: "adapter_1",
  type: "telegram",
  displayName: "Bot",
  enabled: true,
  transportMode: "longpoll",
  settings: {},
  credentialsRef: { keyringService: "x", accounts: [] },
  trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto",
  mediaModelPolicy: "local_extract_only",
  createdAt: 1,
  updatedAt: 1,
}

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
      override: {
        id: "o1",
        sessionId: "s1",
        createdAt: 1,
        updatedAt: 1,
        conversationKey: "c",
        allowComputerUse: true,
        allowOcr: true,
      },
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
