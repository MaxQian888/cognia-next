/**
 * Tests for lib/connectors/dispatch-rules.ts — W3 inbound dispatch rules.
 *
 * Pure-function coverage: keyword any-match (case-insensitive), regex,
 * invalid regex never matches, senderIds vs id/remoteUserId, channelKinds,
 * AND across fields, catch-all empty match, disabled skip, empty-action
 * skip, first-match ordering — plus `resolveEffectiveRouting` precedence
 * (override > rule > instance default; `teamDisabled` kills the rule team).
 */

import { matchDispatchRule, resolveEffectiveRouting } from "./dispatch-rules"
import type { DispatchRule } from "@/lib/db/connector-types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

type MatchEvent = Pick<NormalizedInboundEvent, "plainText" | "sender" | "channel">

function makeEvent(overrides: Partial<MatchEvent> = {}): MatchEvent {
  return {
    plainText: "hello team, the build broke",
    sender: {
      id: "u_alice",
      platform: "telegram",
      adapterId: "adapter_1",
      remoteUserId: "remote_alice",
      displayName: "Alice",
    },
    channel: { id: "ch_1", kind: "group" },
    ...overrides,
  }
}

function rule(over: Partial<DispatchRule> = {}): DispatchRule {
  return {
    id: over.id ?? "r1",
    match: {},
    action: { teamId: "team_a" },
    ...over,
  }
}

describe("matchDispatchRule — field semantics", () => {
  it("returns null for undefined / empty rule lists", () => {
    expect(matchDispatchRule(undefined, makeEvent())).toBeNull()
    expect(matchDispatchRule([], makeEvent())).toBeNull()
  })

  it("matches when ANY keyword is a case-insensitive substring of plainText", () => {
    const r = rule({ match: { keywords: ["BUILD", "deploy"] } })
    expect(matchDispatchRule([r], makeEvent())?.rule.id).toBe("r1")
  })

  it("misses when no keyword is contained", () => {
    const r = rule({ match: { keywords: ["deploy", "release"] } })
    expect(matchDispatchRule([r], makeEvent())).toBeNull()
  })

  it("treats an empty keywords array as not provided (still matches)", () => {
    const r = rule({ match: { keywords: [] } })
    expect(matchDispatchRule([r], makeEvent())).not.toBeNull()
  })

  it("matches a regex pattern against plainText", () => {
    const r = rule({ match: { pattern: "build\\s+broke" } })
    expect(matchDispatchRule([r], makeEvent())?.rule.id).toBe("r1")
  })

  it("misses when the regex does not match", () => {
    const r = rule({ match: { pattern: "^urgent:" } })
    expect(matchDispatchRule([r], makeEvent())).toBeNull()
  })

  it("never matches on an invalid regex (condition fails, no throw)", () => {
    const r = rule({ match: { pattern: "([unclosed" } })
    expect(() => matchDispatchRule([r], makeEvent())).not.toThrow()
    expect(matchDispatchRule([r], makeEvent())).toBeNull()
    // Second call exercises the cached-null path.
    expect(matchDispatchRule([r], makeEvent())).toBeNull()
  })

  it("matches senderIds against sender.id", () => {
    const r = rule({ match: { senderIds: ["u_alice"] } })
    expect(matchDispatchRule([r], makeEvent())).not.toBeNull()
  })

  it("matches senderIds against sender.remoteUserId", () => {
    const r = rule({ match: { senderIds: ["remote_alice"] } })
    expect(matchDispatchRule([r], makeEvent())).not.toBeNull()
  })

  it("misses when no senderId matches either identity", () => {
    const r = rule({ match: { senderIds: ["u_bob", "remote_bob"] } })
    expect(matchDispatchRule([r], makeEvent())).toBeNull()
  })

  it("restricts by channelKinds", () => {
    const priv = rule({ match: { channelKinds: ["private"] } })
    expect(matchDispatchRule([priv], makeEvent())).toBeNull()
    const grp = rule({ match: { channelKinds: ["private", "group"] } })
    expect(matchDispatchRule([grp], makeEvent())).not.toBeNull()
  })

  it("ANDs across fields — all provided conditions must hold", () => {
    const r = rule({
      match: { keywords: ["build"], senderIds: ["u_alice"], channelKinds: ["group"] },
    })
    expect(matchDispatchRule([r], makeEvent())).not.toBeNull()
    // Same rule, one failing leg (sender) → no match despite keyword+kind.
    const r2 = rule({
      match: { keywords: ["build"], senderIds: ["u_bob"], channelKinds: ["group"] },
    })
    expect(matchDispatchRule([r2], makeEvent())).toBeNull()
  })

  it("an empty match object is a catch-all", () => {
    expect(matchDispatchRule([rule({ match: {} })], makeEvent())?.action.teamId).toBe("team_a")
  })
})

describe("matchDispatchRule — rule-table semantics", () => {
  it("skips rules with enabled === false", () => {
    const off = rule({ id: "off", enabled: false })
    const on = rule({ id: "on", action: { teamId: "team_b" } })
    expect(matchDispatchRule([off, on], makeEvent())?.rule.id).toBe("on")
  })

  it("treats enabled: undefined as enabled (default true)", () => {
    expect(matchDispatchRule([rule({ id: "r" })], makeEvent())?.rule.id).toBe("r")
  })

  it("skips rules whose action has no target fields", () => {
    const inert = rule({ id: "inert", action: {} })
    const blank = rule({ id: "blank", action: { teamId: "  " } })
    const live = rule({ id: "live", action: { characterId: "char_x" } })
    const hit = matchDispatchRule([inert, blank, live], makeEvent())
    expect(hit?.rule.id).toBe("live")
    expect(hit?.action.characterId).toBe("char_x")
  })

  it("returns the FIRST matching rule in array order", () => {
    const first = rule({ id: "first", match: { keywords: ["build"] }, action: { teamId: "t1" } })
    const second = rule({ id: "second", match: {}, action: { teamId: "t2" } })
    expect(matchDispatchRule([first, second], makeEvent())?.action.teamId).toBe("t1")
    // When the first misses, the later catch-all wins.
    const miss = rule({ id: "miss", match: { keywords: ["nope"] }, action: { teamId: "t1" } })
    expect(matchDispatchRule([miss, second], makeEvent())?.action.teamId).toBe("t2")
  })
})

describe("resolveEffectiveRouting — precedence", () => {
  const HIT = { rule: rule({ id: "hit" }), action: {} }

  it("override teamId beats rule teamId beats instance default", () => {
    const ruleHit = { ...HIT, action: { teamId: "team_rule" } }
    expect(
      resolveEffectiveRouting(
        { defaultTeamId: "team_inst" },
        { teamId: "team_over" } as never,
        ruleHit
      )
    ).toMatchObject({ teamId: "team_over", teamSource: "override" })
    expect(resolveEffectiveRouting({ defaultTeamId: "team_inst" }, null, ruleHit)).toMatchObject({
      teamId: "team_rule",
      teamSource: "rule",
    })
    expect(resolveEffectiveRouting({ defaultTeamId: "team_inst" }, null, null)).toMatchObject({
      teamId: "team_inst",
      teamSource: "instance-default",
    })
    expect(resolveEffectiveRouting({}, null, null)).toMatchObject({
      teamId: undefined,
      teamSource: "none",
    })
  })

  it("teamDisabled kills override, rule, and instance-default teams", () => {
    const ruleHit = { ...HIT, action: { teamId: "team_rule" } }
    const routing = resolveEffectiveRouting(
      { defaultTeamId: "team_inst" },
      { teamId: "team_over", teamDisabled: true } as never,
      ruleHit
    )
    expect(routing.teamId).toBeUndefined()
    expect(routing.teamSource).toBe("none")
  })

  it("whitespace-only ids are treated as unset at every layer", () => {
    const routing = resolveEffectiveRouting(
      { defaultTeamId: "  " },
      { teamId: " ", workflowId: " ", characterId: " " } as never,
      { ...HIT, action: { teamId: "\t" } }
    )
    expect(routing.teamSource).toBe("none")
    expect(routing.workflowSource).toBe("none")
    expect(routing.characterSource).toBe("none")
  })

  it("override workflowId beats rule workflowId", () => {
    const ruleHit = { ...HIT, action: { workflowId: "wf_rule" } }
    expect(resolveEffectiveRouting({}, { workflowId: "wf_over" } as never, ruleHit)).toMatchObject({
      workflowId: "wf_over",
      workflowSource: "override",
    })
    expect(resolveEffectiveRouting({}, null, ruleHit)).toMatchObject({
      workflowId: "wf_rule",
      workflowSource: "rule",
    })
    expect(resolveEffectiveRouting({}, null, null)).toMatchObject({
      workflowId: undefined,
      workflowSource: "none",
    })
  })

  it("override characterId beats rule characterId", () => {
    const ruleHit = { ...HIT, action: { characterId: "char_rule" } }
    expect(
      resolveEffectiveRouting({}, { characterId: "char_over" } as never, ruleHit)
    ).toMatchObject({ characterId: "char_over", characterSource: "override" })
    expect(resolveEffectiveRouting({}, null, ruleHit)).toMatchObject({
      characterId: "char_rule",
      characterSource: "rule",
    })
    expect(resolveEffectiveRouting({}, null, null)).toMatchObject({
      characterId: undefined,
      characterSource: "none",
    })
  })

  it("a single rule can carry all targets — each surfaces on its own axis", () => {
    const ruleHit = {
      ...HIT,
      action: { teamId: "t", workflowId: "w", characterId: "c", respondViaAdapterId: "bot_b" },
    }
    const routing = resolveEffectiveRouting({}, null, ruleHit)
    expect(routing).toEqual({
      teamId: "t",
      teamSource: "rule",
      workflowId: "w",
      workflowSource: "rule",
      characterId: "c",
      characterSource: "rule",
      respondViaAdapterId: "bot_b",
      respondViaSource: "rule",
    })
  })

  it("respondViaAdapterId is rule-only: unset without a rule hit, trimmed when set", () => {
    expect(resolveEffectiveRouting({}, null, null)).toMatchObject({
      respondViaAdapterId: undefined,
      respondViaSource: "none",
    })
    const ruleHit = { ...HIT, action: { respondViaAdapterId: "  bot_b  " } }
    expect(resolveEffectiveRouting({}, null, ruleHit)).toMatchObject({
      respondViaAdapterId: "bot_b",
      respondViaSource: "rule",
    })
    // Whitespace-only → unset.
    const blank = { ...HIT, action: { respondViaAdapterId: "   " } }
    expect(resolveEffectiveRouting({}, null, blank)).toMatchObject({
      respondViaAdapterId: undefined,
      respondViaSource: "none",
    })
  })
})

describe("matchDispatchRule — respond-via-only rules", () => {
  it("a rule carrying ONLY respondViaAdapterId is a valid routing target", () => {
    const r = rule({ id: "via_only", action: { respondViaAdapterId: "bot_b" } })
    const hit = matchDispatchRule([r], makeEvent())
    expect(hit?.rule.id).toBe("via_only")
    expect(hit?.action.respondViaAdapterId).toBe("bot_b")
  })

  it("a whitespace-only respondViaAdapterId keeps the action inert", () => {
    const r = rule({ id: "blank_via", action: { respondViaAdapterId: "  " } })
    expect(matchDispatchRule([r], makeEvent())).toBeNull()
  })
})
