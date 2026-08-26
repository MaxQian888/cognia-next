/**
 * Tests for the three-layer binding resolver (Task 27).
 *
 * Resolution order (lowest → highest precedence):
 *   adapter defaults → character platformDefaults → conversation override
 *
 * - mode:    adapter.defaultMode → character.platformDefaults.mode → override.mode
 * - charId:  adapter.defaultCharacterId → override.characterId
 * - trigger: deep-merge (arrays replace, not concat)
 */

import type { TriggerPolicy } from "@/types/connectors/policy"
import {
  resolveBinding,
  resolveEffectiveTeamBinding,
  resolveInboxSuppression,
} from "./policy-resolve"
import type { BindingResolutionInput } from "./policy-resolve"

// ── helpers ──────────────────────────────────────────────────────────────────

function baseTrigger(): TriggerPolicy {
  return {
    rules: [{ kind: "private-default" }],
    blockers: [{ kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 30 }],
    storeUnmatchedInDraftMode: false,
  }
}

function adapterOnly(): BindingResolutionInput {
  return {
    adapter: {
      trigger: baseTrigger(),
      defaultMode: "auto",
      defaultCharacterId: "char_default",
    },
    character: null,
    override: null,
  }
}

// ── adapter-only ──────────────────────────────────────────────────────────────

describe("resolveBinding — adapter only", () => {
  it("uses adapter defaultMode", () => {
    const r = resolveBinding(adapterOnly())
    expect(r.mode).toBe("auto")
  })

  it("uses adapter defaultCharacterId", () => {
    const r = resolveBinding(adapterOnly())
    expect(r.characterId).toBe("char_default")
  })

  it("uses adapter trigger verbatim", () => {
    const r = resolveBinding(adapterOnly())
    expect(r.trigger.rules).toEqual([{ kind: "private-default" }])
    expect(r.trigger.storeUnmatchedInDraftMode).toBe(false)
  })

  it("characterId is undefined when adapter has no defaultCharacterId", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "manual", defaultCharacterId: undefined },
      character: null,
      override: null,
    }
    expect(resolveBinding(input).characterId).toBeUndefined()
  })
})

// ── +character layer ──────────────────────────────────────────────────────────

describe("resolveBinding — adapter + character", () => {
  it("character trigger.rules replaces adapter rules", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "auto", defaultCharacterId: undefined },
      character: {
        platformDefaults: {
          trigger: { rules: [{ kind: "self-mention" }] },
        },
      },
      override: null,
    }
    const r = resolveBinding(input)
    expect(r.trigger.rules).toEqual([{ kind: "self-mention" }])
    // blockers from adapter are preserved when character doesn't set them
    expect(r.trigger.blockers).toEqual(baseTrigger().blockers)
  })

  it("character trigger.blockers replaces adapter blockers", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "auto", defaultCharacterId: undefined },
      character: {
        platformDefaults: {
          trigger: {
            blockers: [{ kind: "user-blocklist", userIds: ["u_spammer"] }],
          },
        },
      },
      override: null,
    }
    const r = resolveBinding(input)
    expect(r.trigger.blockers).toEqual([{ kind: "user-blocklist", userIds: ["u_spammer"] }])
    // rules from adapter are preserved
    expect(r.trigger.rules).toEqual(baseTrigger().rules)
  })

  it("character trigger.storeUnmatchedInDraftMode replaces adapter value", () => {
    const input: BindingResolutionInput = {
      adapter: {
        trigger: { ...baseTrigger(), storeUnmatchedInDraftMode: false },
        defaultMode: "draft",
        defaultCharacterId: undefined,
      },
      character: {
        platformDefaults: {
          trigger: { storeUnmatchedInDraftMode: true },
        },
      },
      override: null,
    }
    expect(resolveBinding(input).trigger.storeUnmatchedInDraftMode).toBe(true)
  })

  it("character with no platformDefaults leaves adapter trigger unchanged", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "auto", defaultCharacterId: undefined },
      character: { platformDefaults: undefined },
      override: null,
    }
    const r = resolveBinding(input)
    expect(r.trigger).toEqual(baseTrigger())
  })

  it("character with empty platformDefaults trigger leaves adapter trigger unchanged", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "auto", defaultCharacterId: undefined },
      character: { platformDefaults: { trigger: {} } },
      override: null,
    }
    const r = resolveBinding(input)
    expect(r.trigger).toEqual(baseTrigger())
  })
})

// ── +override layer ───────────────────────────────────────────────────────────

describe("resolveBinding — adapter + override", () => {
  it("override.mode supersedes adapter.defaultMode", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "auto", defaultCharacterId: undefined },
      character: null,
      override: { mode: "manual", characterId: undefined, trigger: undefined },
    }
    expect(resolveBinding(input).mode).toBe("manual")
  })

  it("override.characterId supersedes adapter.defaultCharacterId", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "auto", defaultCharacterId: "char_old" },
      character: null,
      override: { mode: undefined, characterId: "char_new", trigger: undefined },
    }
    expect(resolveBinding(input).characterId).toBe("char_new")
  })

  it("characterDisabled suppresses an explicit and adapter character", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "auto", defaultCharacterId: "char_default" },
      character: null,
      override: {
        mode: undefined,
        characterId: "char_override",
        characterDisabled: true,
        trigger: undefined,
      },
    }
    expect(resolveBinding(input).characterId).toBeUndefined()
  })

  it("override.trigger.rules replaces combined adapter+character rules", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "auto", defaultCharacterId: undefined },
      character: {
        platformDefaults: { trigger: { rules: [{ kind: "self-mention" }] } },
      },
      override: {
        mode: undefined,
        characterId: undefined,
        trigger: { rules: [{ kind: "slash-command", prefixes: ["/ask"] }] },
      },
    }
    const r = resolveBinding(input)
    expect(r.trigger.rules).toEqual([{ kind: "slash-command", prefixes: ["/ask"] }])
  })

  it("override.trigger.storeUnmatchedInDraftMode set without rules preserves existing rules", () => {
    const charRules = [{ kind: "self-mention" as const }]
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "draft", defaultCharacterId: undefined },
      character: {
        platformDefaults: { trigger: { rules: charRules } },
      },
      override: {
        mode: undefined,
        characterId: undefined,
        trigger: { storeUnmatchedInDraftMode: true },
      },
    }
    const r = resolveBinding(input)
    // rules come from the character layer (not replaced by override)
    expect(r.trigger.rules).toEqual(charRules)
    expect(r.trigger.storeUnmatchedInDraftMode).toBe(true)
  })

  it("override with undefined mode falls through to adapter mode", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "draft", defaultCharacterId: undefined },
      character: null,
      override: { mode: undefined, characterId: undefined, trigger: undefined },
    }
    expect(resolveBinding(input).mode).toBe("draft")
  })
})

// ── three-layer full stack ────────────────────────────────────────────────────

describe("resolveBinding — all three layers", () => {
  it("override wins over character wins over adapter for mode", () => {
    const input: BindingResolutionInput = {
      adapter: { trigger: baseTrigger(), defaultMode: "auto", defaultCharacterId: undefined },
      character: { platformDefaults: { mode: "manual" } },
      override: { mode: "draft", characterId: undefined, trigger: undefined },
    }
    // Character has no mode in the Character type — skipped; override wins
    expect(resolveBinding(input).mode).toBe("draft")
  })

  it("override wins for trigger.rules; character wins for trigger.blockers when override omits blockers", () => {
    const input: BindingResolutionInput = {
      adapter: {
        trigger: {
          rules: [{ kind: "private-default" }],
          blockers: [{ kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 30 }],
          storeUnmatchedInDraftMode: false,
        },
        defaultMode: "auto",
        defaultCharacterId: undefined,
      },
      character: {
        platformDefaults: {
          trigger: {
            blockers: [{ kind: "user-blocklist", userIds: ["u_bad"] }],
          },
        },
      },
      override: {
        mode: undefined,
        characterId: undefined,
        trigger: { rules: [{ kind: "self-mention" }] },
      },
    }
    const r = resolveBinding(input)
    expect(r.trigger.rules).toEqual([{ kind: "self-mention" }])
    expect(r.trigger.blockers).toEqual([{ kind: "user-blocklist", userIds: ["u_bad"] }])
  })
})

// ── resolveEffectiveTeamBinding (instance-level defaults, W1) ────────────────

describe("resolveEffectiveTeamBinding", () => {
  it("explicit conversation teamId wins over the instance default", () => {
    const r = resolveEffectiveTeamBinding(
      { defaultTeamId: "team_bot" },
      { teamId: "team_chat", teamDisabled: undefined }
    )
    expect(r).toEqual({ teamId: "team_chat", source: "override" })
  })

  it("falls back to the instance defaultTeamId when no override", () => {
    const r = resolveEffectiveTeamBinding({ defaultTeamId: "team_bot" }, null)
    expect(r).toEqual({ teamId: "team_bot", source: "instance-default" })
  })

  it("falls back to the instance default when the override row exists but has no teamId", () => {
    const r = resolveEffectiveTeamBinding(
      { defaultTeamId: "team_bot" },
      { teamId: undefined, teamDisabled: undefined }
    )
    expect(r).toEqual({ teamId: "team_bot", source: "instance-default" })
  })

  it("teamDisabled suppresses BOTH the override teamId and the instance default", () => {
    const r = resolveEffectiveTeamBinding(
      { defaultTeamId: "team_bot" },
      { teamId: "team_chat", teamDisabled: true }
    )
    expect(r).toEqual({ teamId: undefined, source: "none" })
  })

  it("returns none when neither layer binds a team", () => {
    const r = resolveEffectiveTeamBinding({ defaultTeamId: undefined }, null)
    expect(r).toEqual({ teamId: undefined, source: "none" })
  })

  it("treats empty / whitespace ids as unset at both layers", () => {
    expect(resolveEffectiveTeamBinding({ defaultTeamId: "  " }, { teamId: "" })).toEqual({
      teamId: undefined,
      source: "none",
    })
    expect(resolveEffectiveTeamBinding({ defaultTeamId: "team_bot" }, { teamId: "  " })).toEqual({
      teamId: "team_bot",
      source: "instance-default",
    })
  })

  it("undefined override behaves like null (no override row)", () => {
    const r = resolveEffectiveTeamBinding({ defaultTeamId: "team_bot" }, undefined)
    expect(r).toEqual({ teamId: "team_bot", source: "instance-default" })
  })
})

// ── character-recommended mode ───────────────────────────────────────────────

describe("resolveBinding — character platformDefaults.mode", () => {
  // The layer existed in the type and was explicitly skipped by the resolver,
  // so a character pack could ship a mode that took effect nowhere.
  it("applies over the adapter default and reports where it came from", () => {
    const resolved = resolveBinding({
      ...adapterOnly(),
      character: { platformDefaults: { mode: "draft" } },
    })
    expect(resolved.mode).toBe("draft")
    expect(resolved.modeSource).toBe("character-default")
  })

  it("yields to an explicit conversation override", () => {
    const resolved = resolveBinding({
      ...adapterOnly(),
      character: { platformDefaults: { mode: "draft" } },
      override: { mode: "manual" } as BindingResolutionInput["override"],
    })
    expect(resolved.mode).toBe("manual")
    expect(resolved.modeSource).toBe("conversation-override")
  })

  it("leaves the adapter default alone when the character recommends nothing", () => {
    const resolved = resolveBinding({
      ...adapterOnly(),
      character: { platformDefaults: { trigger: { storeUnmatchedInDraftMode: true } } },
    })
    expect(resolved.mode).toBe("auto")
    expect(resolved.modeSource).toBe("adapter-default")
  })
})

describe("resolveInboxSuppression", () => {
  const window = { from: "22:00", to: "08:00", tz: "UTC" }
  const other = { from: "12:00", to: "13:00", tz: "Asia/Shanghai" }

  it("is quiet about a bot and chat that are both awake", () => {
    expect(resolveInboxSuppression({}, null)).toEqual({ quietHours: undefined, muted: false })
  })

  // A killswitch in both places: a conversation cannot un-mute a muted bot.
  it.each([
    [{ muted: true }, null, "adapter"],
    [{}, { muted: true }, "conversation"],
    [{ muted: true }, { muted: true }, "adapter"],
    [{ muted: true }, { muted: false }, "adapter"],
  ] as const)("mutes on either layer (%o, %o)", (adapter, override, scope) => {
    const result = resolveInboxSuppression(adapter, override)
    expect(result.muted).toBe(true)
    expect(result.mutedScope).toBe(scope)
  })

  it("leaves the scope off when nothing is muted", () => {
    expect(resolveInboxSuppression({}, { muted: false })).not.toHaveProperty("mutedScope")
  })

  // A window is a whole statement about when this chat is awake; merging two
  // has no meaning, so the conversation's replaces the bot's outright.
  it("lets a conversation window replace the bot's", () => {
    expect(resolveInboxSuppression({ quietHours: window }, { quietHours: other }).quietHours).toBe(
      other
    )
  })

  it("falls back to the bot's window when the chat sets none", () => {
    expect(resolveInboxSuppression({ quietHours: window }, {}).quietHours).toBe(window)
    expect(resolveInboxSuppression({ quietHours: window }, null).quietHours).toBe(window)
  })
})
