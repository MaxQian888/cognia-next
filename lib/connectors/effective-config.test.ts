import { resolveImEffectiveConfig } from "./effective-config"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"

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
  mediaModelPolicy: "local_extract_only",
  createdAt: 1,
  updatedAt: 1,
}

describe("resolveImEffectiveConfig", () => {
  it("reports requested, effective, and source for shared behavior fields", () => {
    const configuredAdapter: AdapterInstanceRow = {
      ...adapter,
      inboundActivationPolicy: "mention_each",
      activeRunDispatchMode: "queue",
      activationTtlMs: 3_600_000,
    }
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
      override: {
        id: "o1",
        sessionId: "s1",
        createdAt: 1,
        updatedAt: 1,
        conversationKey: "c",
        teamDisabled: true,
      },
      rule: null,
      system: { mode: "auto" },
    })
    expect(direct.target).toMatchObject({
      effective: { kind: "direct" },
      source: "conversation-override",
    })
  })

  it("labels assignment-driven routing and mode as source 'assignment' (slice 1A)", () => {
    const assigned = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultTeamId: "team_a" },
      override: {
        id: "o1",
        sessionId: "s1",
        createdAt: 1,
        updatedAt: 1,
        conversationKey: "c",
        teamId: "team_asg",
        characterId: "char_asg",
        routingSource: "assignment",
        mode: "manual",
        assignmentPreviousMode: "auto",
      },
      rule: null,
      system: { mode: "auto" },
    })
    expect(assigned.target).toMatchObject({
      effective: { kind: "team", id: "team_asg" },
      source: "assignment",
    })
    expect(assigned.character).toMatchObject({ effective: "char_asg", source: "assignment" })
    expect(assigned.mode).toEqual({
      requested: "manual",
      effective: "manual",
      source: "assignment",
    })

    // A human assignment on a row that had NO explicit mode records `null` —
    // still assignment provenance.
    const inheritPrev = resolveImEffectiveConfig({
      adapter,
      override: {
        id: "o1",
        sessionId: "s1",
        createdAt: 1,
        updatedAt: 1,
        conversationKey: "c",
        mode: "manual",
        assignmentPreviousMode: null,
      },
      rule: null,
      system: { mode: "auto" },
    })
    expect(inheritPrev.mode.source).toBe("assignment")

    // Explicit mode edit (marker cleared) → conversation-override again.
    const explicit = resolveImEffectiveConfig({
      adapter,
      override: {
        id: "o1",
        sessionId: "s1",
        createdAt: 1,
        updatedAt: 1,
        conversationKey: "c",
        mode: "manual",
      },
      rule: null,
      system: { mode: "auto" },
    })
    expect(explicit.mode.source).toBe("conversation-override")
  })

  it("keeps Character independent and marks invalid explicit references blocked", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultTeamId: "team_a" },
      override: {
        id: "o1",
        sessionId: "s1",
        createdAt: 1,
        updatedAt: 1,
        conversationKey: "c",
        characterId: "char_missing",
      },
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
      override: {
        id: "o1",
        sessionId: "s1",
        createdAt: 1,
        updatedAt: 1,
        conversationKey: "c",
        providerOverride: "openai",
        modelOverride: "gpt",
      },
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
      override: {
        id: "o1",
        sessionId: "s1",
        createdAt: 1,
        updatedAt: 1,
        conversationKey: "c",
        allowComputerUse: true,
      },
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

const override = (patch: Partial<ConversationOverrideRow>): ConversationOverrideRow => ({
  id: "o1",
  conversationKey: "telegram:a1:c1",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
  sessionId: patch.sessionId ?? "s1",
})

describe("composed-mode axes", () => {
  it("derives autonomy and engagement from the legacy pair when a row has neither", () => {
    const result = resolveImEffectiveConfig({
      adapter,
      override: null,
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.autonomy.effective).toBe("act")
    expect(result.engagement.effective).toBe("inline")
  })

  it("keeps a team-bound conversation detached even in draft mode", () => {
    // The `draft-prepare` bug in axis terms: draft is an autonomy level, not a
    // route, so the team still runs and its product is what waits for a human.
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultTeamId: "team-1" },
      override: override({ mode: "draft" }),
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.target.effective).toEqual({ kind: "team", id: "team-1" })
    expect(result.autonomy.effective).toBe("suggest")
    expect(result.engagement.effective).toBe("background")
  })

  it("prefers an explicit axis write over the derived value", () => {
    const result = resolveImEffectiveConfig({
      adapter,
      override: override({ mode: "auto", autonomy: "confirm", engagement: "background" }),
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.autonomy).toMatchObject({
      requested: "confirm",
      effective: "confirm",
      source: "conversation-override",
    })
    expect(result.engagement.effective).toBe("background")
  })

  it("resolves a human assignment to human engagement", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultTeamId: "team-1" },
      override: override({ mode: "manual", assignmentPreviousMode: "auto" }),
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.engagement.effective).toBe("human")
    expect(result.autonomy.effective).toBe("observe")
    expect(result.mode.source).toBe("assignment")
  })

  it("labels an SLA-forced mode as escalation instead of an operator edit", () => {
    const result = resolveImEffectiveConfig({
      adapter,
      override: override({ mode: "draft", modeForcedBy: "escalation" }),
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.mode.source).toBe("escalation")
    expect(result.autonomy.source).toBe("escalation")
  })

  it("projects approvalMode onto authority", () => {
    expect(
      resolveImEffectiveConfig({
        adapter,
        override: override({ approvalMode: "yolo" }),
        rule: null,
        system: { mode: "auto" },
      }).authority.effective
    ).toBe("bypassPermissions")

    expect(
      resolveImEffectiveConfig({
        adapter,
        override: null,
        rule: null,
        system: { mode: "auto" },
      }).authority.effective
    ).toBeUndefined()
  })

  it("takes bot-level axis defaults when the conversation says nothing", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultAutonomy: "suggest", defaultAuthority: "plan" },
      override: null,
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.autonomy).toMatchObject({ effective: "suggest", source: "adapter-default" })
    expect(result.authority).toMatchObject({ effective: "plan", source: "adapter-default" })
  })

  // The conversation layer wins as a WHOLE. Mixing a chat's `mode` with the
  // bot's axis default let `defaultAutonomy: "act"` outrank `/mode manual` —
  // the chat read "manual" in the chip, in `/status` and in this facade while
  // the bus kept routing it as a running turn.
  it("lets a conversation's mode outrank the bot's axis defaults", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultAutonomy: "act", defaultEngagement: "inline" },
      override: override({ mode: "manual" }),
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.mode.effective).toBe("manual")
    expect(result.autonomy.effective).toBe("observe")
    expect(result.engagement.effective).toBe("human")
    // And it must not claim the bot default it just suppressed.
    expect(result.autonomy.source).toBe("conversation-override")
  })

  // `/mode` clears the conversation's own axes on purpose, so this is the
  // shape the clear actually lands in.
  it("keeps the bot's axis default when the conversation pins no mode", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultAutonomy: "act" },
      override: override({ pinned: true }),
      rule: null,
      system: { mode: "manual" },
    })
    expect(result.autonomy).toMatchObject({ effective: "act", source: "adapter-default" })
  })

  // An explicit conversation axis still beats the mode it sits next to — the
  // fix narrows which BOT-level value applies, it does not demote the chat's.
  it("still prefers an explicit conversation axis over its own mode", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultAutonomy: "act" },
      override: override({ mode: "manual", autonomy: "suggest" }),
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.autonomy).toMatchObject({
      effective: "suggest",
      source: "conversation-override",
    })
  })

  // Authority's conversation-level spelling is `approvalMode`, not `mode`: a
  // chat switched to manual has said nothing about permissions.
  it("does not let a conversation's mode suppress the bot's authority default", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultAuthority: "plan" },
      override: override({ mode: "manual" }),
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.authority).toMatchObject({ effective: "plan", source: "adapter-default" })
  })

  it("lets a conversation's approvalMode outrank the bot's authority default", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultAuthority: "plan" },
      override: override({ approvalMode: "yolo" }),
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.authority).toMatchObject({
      effective: "bypassPermissions",
      source: "conversation-override",
    })
  })
})

describe("session layer", () => {
  it("reports the session model that the send path will actually use", () => {
    // The `/status` divergence: `resolveSendOptions` reads `session.model`
    // between the conversation override and the bot default.
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultModel: "bot-default" },
      override: null,
      rule: null,
      system: { mode: "auto" },
      session: { model: "session-model" },
    })
    expect(result.model).toMatchObject({ effective: "session-model", source: "session" })
  })

  it("still lets a conversation override beat the session", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultModel: "bot-default" },
      override: override({ modelOverride: "channel-model" }),
      rule: null,
      system: { mode: "auto" },
      session: { model: "session-model" },
    })
    expect(result.model).toMatchObject({
      effective: "channel-model",
      source: "conversation-override",
    })
  })

  it("keeps today's answer when no session is passed", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultModel: "bot-default", defaultProvider: "anthropic" },
      override: null,
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.model).toMatchObject({ effective: "bot-default", source: "adapter-default" })
    expect(result.provider).toMatchObject({ effective: "anthropic", source: "adapter-default" })
  })

  it("still blanks provider and model for a delegated conversation", () => {
    const result = resolveImEffectiveConfig({
      adapter: { ...adapter, defaultTeamId: "team-1", defaultModel: "bot-default" },
      override: null,
      rule: null,
      system: { mode: "auto" },
      session: { model: "session-model" },
    })
    expect(result.model).toMatchObject({
      effective: undefined,
      blockedReason: "managed_by_target",
    })
  })
})

describe("resolveImEffectiveConfig — character-recommended mode", () => {
  // A character shipping `platformDefaults.mode` used to be skipped by
  // `resolveBinding` entirely. Now that it lands, the read-out has to say so:
  // labelling it `adapter-default` would make a persona recommendation
  // indistinguishable from a bot-wide setting in every UI.
  it("labels a mode the character recommended", () => {
    const result = resolveImEffectiveConfig({
      adapter,
      override: null,
      rule: null,
      system: { mode: "draft", modeSource: "character-default" },
    })
    expect(result.mode.effective).toBe("draft")
    expect(result.mode.source).toBe("character-default")
    // Autonomy is derived from that mode, so it inherits the provenance
    // rather than claiming a default nobody chose.
    expect(result.autonomy.effective).toBe("suggest")
    expect(result.autonomy.source).toBe("character-default")
  })

  it("keeps reporting adapter-default when nothing recommends anything", () => {
    const result = resolveImEffectiveConfig({
      adapter,
      override: null,
      rule: null,
      system: { mode: "auto" },
    })
    expect(result.mode.source).toBe("adapter-default")
  })

  it("yields to an explicit conversation override", () => {
    const result = resolveImEffectiveConfig({
      adapter,
      override: {
        id: "o1",
        conversationKey: "telegram:a1:c1",
        sessionId: "s1",
        mode: "manual",
        createdAt: 1,
        updatedAt: 1,
      },
      rule: null,
      system: { mode: "draft", modeSource: "character-default" },
    })
    expect(result.mode.effective).toBe("manual")
    expect(result.mode.source).toBe("conversation-override")
  })
})
