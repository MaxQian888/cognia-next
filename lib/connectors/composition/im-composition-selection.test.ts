import { resolveImEffectiveConfig } from "@/lib/connectors/effective-config"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"

import { projectImComposition } from "./im-composition-selection"

const adapter: AdapterInstanceRow = {
  id: "a1",
  type: "telegram",
  displayName: "Bot",
  enabled: true,
  transportMode: "longpoll",
  settings: {},
  credentialsRef: { keyringService: "x", accounts: [] },
  trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto",
  createdAt: 1,
  updatedAt: 1,
}

function project(
  adapterPatch: Partial<AdapterInstanceRow> = {},
  overridePatch: Partial<ConversationOverrideRow> | null = null
) {
  const effective = resolveImEffectiveConfig({
    adapter: { ...adapter, ...adapterPatch },
    override: overridePatch
      ? { id: "o1", conversationKey: "k", createdAt: 1, updatedAt: 1, ...overridePatch }
      : null,
    rule: null,
    system: { mode: "auto" },
  })
  return projectImComposition({ effective, knownPresetIds: new Set(["standard", "minimal"]) })
}

describe("projectImComposition", () => {
  it("projects a plain direct auto-reply conversation", () => {
    expect(project().selection).toEqual({
      presetId: "standard",
      orchestration: "direct",
      engagement: "inline",
      autonomy: "act",
    })
  })

  it("projects a team-bound conversation onto team orchestration plus a ref", () => {
    const { selection } = project({ defaultTeamId: "team-7" })
    expect(selection.orchestration).toBe("team")
    expect(selection.orchestrationRef).toBe("team-7")
    expect(selection.engagement).toBe("background")
  })

  it("keeps a team-bound draft conversation delegated", () => {
    // The regression: the old draft route resolved no target at all.
    const { selection } = project({ defaultTeamId: "team-7" }, { mode: "draft" })
    expect(selection.orchestration).toBe("team")
    expect(selection.engagement).toBe("background")
    expect(selection.autonomy).toBe("suggest")
  })

  it("never carries an orchestrationRef for a direct conversation", () => {
    expect(project().selection).not.toHaveProperty("orchestrationRef")
  })

  it("omits authority when the conversation has no opinion", () => {
    // Defaulting it would let a conversation that never chose anything
    // override a preset recommendation.
    expect(project().selection).not.toHaveProperty("authority")
  })

  it("carries an explicit approvalMode through as authority", () => {
    expect(project({}, { approvalMode: "yolo" }).selection.authority).toBe("bypassPermissions")
  })

  it("reports where each axis came from", () => {
    const { provenance } = project({ defaultTeamId: "team-7" }, { autonomy: "confirm" })
    expect(provenance.autonomy).toBe("conversation-override")
    expect(provenance.orchestration).toBe("adapter-default")
    expect(provenance.preset).toBe("system-default")
  })

  it("labels an SLA-forced level as escalation", () => {
    const { provenance } = project({}, { mode: "draft", modeForcedBy: "escalation" })
    expect(provenance.autonomy).toBe("escalation")
  })
})

describe("preset from the session mode", () => {
  it("takes the preset and any legacy axis overlay from the session's mode id", () => {
    const effective = resolveImEffectiveConfig({
      adapter,
      override: null,
      rule: null,
      system: { mode: "auto" },
    })
    const { selection, provenance } = projectImComposition({
      effective,
      sessionModeId: "plan",
      knownPresetIds: new Set(["standard", "minimal"]),
    })
    expect(selection.presetId).toBe("standard")
    expect(selection.authority).toBe("plan")
    expect(selection.legacyModeId).toBe("plan")
    expect(provenance.preset).toBe("session")
  })

  it("lets the conversation's own axes outrank the session mode", () => {
    const effective = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultTeamId: "team-9" },
      override: {
        id: "o1",
        conversationKey: "k",
        createdAt: 1,
        updatedAt: 1,
        approvalMode: "yolo",
      },
      rule: null,
      system: { mode: "auto" },
    })
    const { selection } = projectImComposition({
      effective,
      sessionModeId: "plan",
      knownPresetIds: new Set(["standard", "minimal"]),
    })
    // The channel said "yolo" explicitly; the session mode did not.
    expect(selection.authority).toBe("bypassPermissions")
    expect(selection.orchestration).toBe("team")
  })
})
