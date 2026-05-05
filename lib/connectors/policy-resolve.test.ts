/**
 * Tests for the three-layer binding resolver (Task 27).
 *
 * Resolution order (lowest → highest precedence):
 *   adapter defaults → character platformDefaults → conversation override
 *
 * - mode:    adapter.defaultMode → override.mode
 * - charId:  adapter.defaultCharacterId → override.characterId
 * - trigger: deep-merge (arrays replace, not concat)
 */

import type { TriggerPolicy } from "@/types/connectors/policy"
import { resolveBinding } from "./policy-resolve"
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
