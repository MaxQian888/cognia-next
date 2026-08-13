import { resolveImEffectiveConfig } from "./effective-config"

const adapter = {
  id: "a1",
  type: "telegram",
  displayName: "Bot",
  enabled: true,
  transportMode: "long-poll",
  settings: {},
  credentialsRef: { keyringService: "x", accounts: [] },
  trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto",
  createdAt: 1,
  updatedAt: 1,
} as const

describe("resolveImEffectiveConfig", () => {
  it("reports requested, effective, and source for shared behavior fields", () => {
    const configuredAdapter = {
      ...adapter,
      inboundActivationPolicy: "mention_each",
      activeRunDispatchMode: "queue",
      activationTtlMs: 3_600_000,
    } as const
    const result = resolveImEffectiveConfig({
      adapter: configuredAdapter,
      override: {
        id: "o1",
        conversationKey: "telegram:a1:c1",
        sessionId: "s1",
        activeRunDispatchMode: "steer",
        createdAt: 1,
        updatedAt: 1,
      },
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.behavior).toEqual({
      inboundActivationPolicy: {
        requested: undefined,
        effective: "mention_each",
        source: "adapter-default",
      },
      activeRunDispatchMode: {
        requested: "steer",
        effective: "steer",
        source: "conversation-override",
      },
      activationTtlMs: {
        requested: undefined,
        effective: 3_600_000,
        source: "adapter-default",
      },
    })
  })

  it("resolves override → rule → adapter → direct and preserves historical Team priority", () => {
    const both = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultTeamId: "team_a", defaultWorkflowId: "wf_a" },
      override: null,
      rule: null,
      system: { mode: "auto" },
    })
    expect(both.target.effective).toEqual({ kind: "team", id: "team_a" })
    expect(both.target.source).toBe("adapter-default")

    const direct = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultTeamId: "team_a" },
      override: { conversationKey: "c", teamDisabled: true },
      rule: null,
      system: { mode: "auto" },
    })
    expect(direct.target).toMatchObject({
      effective: { kind: "direct" },
      source: "conversation-override",
    })
  })

  it("keeps Character independent and marks invalid explicit references blocked", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultTeamId: "team_a" },
      override: { conversationKey: "c", characterId: "char_missing" },
      rule: null,
      system: { mode: "auto" },
      references: { characterExists: false },
    })
    expect(result.character).toMatchObject({
      effective: "char_missing",
      source: "conversation-override",
      blockedReason: "character_reference_missing",
    })
  })

  it("makes Provider/Model target-managed outside Direct Agent", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultWorkflowId: "wf" },
      override: { conversationKey: "c", providerOverride: "openai", modelOverride: "gpt" },
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.provider).toMatchObject({
      effective: undefined,
      source: "target-managed",
      blockedReason: "managed_by_target",
    })
    expect(result.model.source).toBe("target-managed")
  })

  it("reports permission sources and keeps high-risk host grants conversation-scoped", () => {
    const result = resolveImEffectiveConfig({
      adapter: {
        ...adapter,
        requireHitlForWrites: false,
        hostCapabilityCeiling: ["computer_use", "ocr"],
      },
      override: { conversationKey: "c", allowComputerUse: true },
      rule: null,
      system: { mode: "auto" },
      characterComputerUseEnabled: true,
    })
    expect(result.permissions.hostCapabilities).toMatchObject({
      computer_use: true,
      ocr: true,
      goal_driving: false,
      schedule_tools: false,
    })
    expect(result.permissions.requireHitlForWrites).toMatchObject({
      effective: false,
      source: "adapter-default",
    })
  })
})
