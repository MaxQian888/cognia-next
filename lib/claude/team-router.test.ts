import {
  HANDOFF_STOP_TOKEN,
  MAX_TURNS_PER_MEMBER_PER_ROUND,
  buildSupervisorRoster,
  hasHandoffStopToken,
  parseDispatches,
  parseHandoffTargets,
  clampTalkativeness,
  holdReasonFor,
  parseMentions,
  planAutoRound,
  planUserTurn,
  routeTurn,
  stickyResponderOf,
  stripDispatches,
  stripHandoffStopToken,
} from "./team-router"
import type { Character, Team, TeamMember } from "@cognia/agent-config-types"

function makeCharacter(overrides: Partial<Character> & { id: string; name: string }): Character {
  return {
    avatarColor: "oklch(0.7 0 0)",
    systemPrompt: "",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Character
}

function makeTeam(overrides: Partial<Team> & { members: TeamMember[] }): Team {
  return {
    id: "team_test",
    name: "Test Team",
    avatarColor: "oklch(0.7 0 0)",
    orchestration: "mention_round_robin",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Team
}

describe("parseMentions", () => {
  const coder = makeCharacter({ id: "c1", name: "Coder" })
  const coderPro = makeCharacter({ id: "c2", name: "Coder Pro" })
  const writer = makeCharacter({ id: "c3", name: "Writer" })
  const members = [coder, coderPro, writer]

  it("returns empty when no mentions", () => {
    expect(parseMentions("hi everyone", members)).toEqual([])
  })

  it("returns empty for empty string", () => {
    expect(parseMentions("", members)).toEqual([])
  })

  it("returns empty when members list is empty", () => {
    expect(parseMentions("@Coder hi", [])).toEqual([])
  })

  it("matches a single mention case-insensitively", () => {
    expect(parseMentions("@coder fix this", members)).toEqual([coder])
    expect(parseMentions("@CODER fix this", members)).toEqual([coder])
  })

  it("preserves order across multiple mentions", () => {
    const result = parseMentions("@Writer please review what @Coder did", members)
    expect(result).toEqual([writer, coder])
  })

  it("deduplicates the same mention", () => {
    expect(parseMentions("@Coder ping @Coder again", members)).toEqual([coder])
  })

  it("longest-match-first: 'Coder Pro' beats 'Coder' even when both could match", () => {
    expect(parseMentions("@Coder Pro check this", members)).toEqual([coderPro])
  })

  it("does not bleed into adjacent words", () => {
    expect(parseMentions("@Coderbot ping", members)).toEqual([])
  })

  it("matches when followed by punctuation", () => {
    expect(parseMentions("hey @Coder, take a look", members)).toEqual([coder])
    expect(parseMentions("@Coder!", members)).toEqual([coder])
    expect(parseMentions("@Coder.", members)).toEqual([coder])
  })

  it("matches at end of string", () => {
    expect(parseMentions("ping @Coder", members)).toEqual([coder])
  })

  it("ignores '@' with nothing after it", () => {
    expect(parseMentions("@ at end", members)).toEqual([])
    expect(parseMentions("just an @ here", members)).toEqual([])
  })

  it("ignores @-tokens that don't match any member", () => {
    expect(parseMentions("@Nobody here", members)).toEqual([])
  })

  it("ignores an @ that follows a non-whitespace char (email / path)", () => {
    expect(parseMentions("write to coder@Coder.io", members)).toEqual([])
    expect(parseMentions("see path/@Coder", members)).toEqual([])
  })

  it("is generic over any {id,name} shape (chat @agent reuse)", () => {
    // The chat composer projects subagent targets to `{ id, name: handle }`
    // and reuses this exact scanner — no Character coupling.
    const agents = [
      { id: "template:reviewer", name: "reviewer" },
      { id: "workflow-designer", name: "workflow-designer" },
    ]
    const result = parseMentions("please @reviewer then @workflow-designer", agents)
    expect(result).toEqual([agents[0], agents[1]])
    expect(result[0]?.id).toBe("template:reviewer")
  })

  it("handles members whose names contain spaces", () => {
    expect(parseMentions("@Coder Pro: do this", members)).toEqual([coderPro])
  })

  it("handles back-to-back mentions separated by space", () => {
    expect(parseMentions("@Coder @Writer", members)).toEqual([coder, writer])
  })
})

describe("routeTurn", () => {
  const coder = makeCharacter({ id: "c1", name: "Coder" })
  const writer = makeCharacter({ id: "c2", name: "Writer" })
  const reviewer = makeCharacter({ id: "c3", name: "Reviewer" })
  const members = [coder, writer, reviewer]

  describe("mention_round_robin", () => {
    const team = makeTeam({
      members: [{ characterId: "c1" }, { characterId: "c2" }, { characterId: "c3" }],
      orchestration: "mention_round_robin",
    })

    it("returns mentioned members when @-tokens are present", () => {
      expect(routeTurn(team, members, "@Writer please review")).toEqual([writer])
    })

    it("returns multiple mentioned members in order", () => {
      expect(routeTurn(team, members, "@Writer @Reviewer pls help")).toEqual([writer, reviewer])
    })

    it("uses the selected primary member when no Agent is mentioned", () => {
      expect(routeTurn(team, members, "who should answer?", "c2")).toEqual([writer])
    })

    it("falls back to the first declared member when utility routing is unavailable", () => {
      const reordered = makeTeam({
        members: [{ characterId: "c3" }, { characterId: "c1" }, { characterId: "c2" }],
        orchestration: "mention_round_robin",
      })
      expect(routeTurn(reordered, members, "anyone?")).toEqual([reviewer])
    })

    it("drops members that no longer exist in the characters list", () => {
      const teamWithGhost = makeTeam({
        members: [{ characterId: "c1" }, { characterId: "c_ghost" }, { characterId: "c2" }],
        orchestration: "mention_round_robin",
      })
      expect(routeTurn(teamWithGhost, members, "go")).toEqual([coder])
    })
  })

  describe("round_robin", () => {
    const team = makeTeam({
      members: [{ characterId: "c1" }, { characterId: "c2" }, { characterId: "c3" }],
      orchestration: "round_robin",
    })

    it("lets an explicit mention override the all-response policy", () => {
      expect(routeTurn(team, members, "@Writer only please")).toEqual([writer])
    })

    it("caps all-response fan-out", () => {
      const capped = { ...team, maxResponses: 2 }
      expect(routeTurn(capped, members, "everyone answer")).toEqual([coder, writer])
    })
  })

  describe("manual", () => {
    const team = makeTeam({
      members: [{ characterId: "c1" }, { characterId: "c2" }],
      orchestration: "manual",
    })

    it("waits for a user pick unless a member is explicitly mentioned", () => {
      expect(routeTurn(team, members, "anyone?")).toEqual([])
      expect(routeTurn(team, members, "@Writer go")).toEqual([writer])
    })
  })

  describe("supervisor", () => {
    const team = makeTeam({
      members: [{ characterId: "c1" }, { characterId: "c2" }],
      orchestration: "supervisor",
    })

    it("uses the supervisor flow unless an explicit mention targets a member", () => {
      expect(routeTurn(team, members, "anyone?")).toEqual([])
      expect(routeTurn(team, members, "@Writer go")).toEqual([writer])
    })
  })
})

describe("parseDispatches", () => {
  const alice = makeCharacter({
    id: "c_alice",
    name: "Alice",
    description: "Researcher",
  })
  const bob = makeCharacter({
    id: "c_bob",
    name: "Bob",
    description: "Critic",
  })
  const carol = makeCharacter({ id: "c_carol", name: "Carol" })
  const members = [alice, bob, carol]

  it("returns empty for empty input", () => {
    expect(parseDispatches("", members)).toEqual([])
  })

  it("extracts a single dispatch", () => {
    const out = parseDispatches('<dispatch to="Alice">do thing</dispatch>', members)
    expect(out).toEqual([{ characterId: "c_alice", characterName: "Alice", task: "do thing" }])
  })

  it("matches names case-insensitively after trim", () => {
    const out = parseDispatches(
      '<dispatch to="  alice  ">x</dispatch><dispatch to="BOB">y</dispatch>',
      members
    )
    expect(out.map((d) => d.characterName)).toEqual(["Alice", "Bob"])
  })

  it("ignores unmatched names", () => {
    const out = parseDispatches('<dispatch to="Mallory">x</dispatch>', members)
    expect(out).toEqual([])
  })

  it("returns dispatches in source order, allowing duplicates", () => {
    const out = parseDispatches(
      '<dispatch to="Bob">a</dispatch>then<dispatch to="Alice">b</dispatch><dispatch to="Bob">c</dispatch>',
      members
    )
    expect(out.map((d) => `${d.characterName}:${d.task}`)).toEqual(["Bob:a", "Alice:b", "Bob:c"])
  })

  it("ignores dispatches with empty bodies", () => {
    const out = parseDispatches(
      '<dispatch to="Alice">   </dispatch><dispatch to="Bob">work</dispatch>',
      members
    )
    expect(out.map((d) => d.characterName)).toEqual(["Bob"])
  })

  it("ignores malformed (unclosed) dispatch tags", () => {
    const out = parseDispatches('<dispatch to="Alice">never closed', members)
    expect(out).toEqual([])
  })

  it("supports single-quoted attributes", () => {
    const out = parseDispatches(`<dispatch to='Alice'>x</dispatch>`, members)
    expect(out).toHaveLength(1)
    expect(out[0].characterName).toBe("Alice")
  })

  it("captures non-greedy spans across multiple tags", () => {
    const out = parseDispatches(
      '<dispatch to="Alice">first</dispatch> middle <dispatch to="Bob">second</dispatch>',
      members
    )
    expect(out.map((d) => d.task)).toEqual(["first", "second"])
  })
})

describe("stripDispatches", () => {
  it("removes the tags but preserves surrounding text", () => {
    const text = 'Plan: <dispatch to="Alice">explore</dispatch>\nAnd then summarize.'
    expect(stripDispatches(text)).toBe("Plan: \nAnd then summarize.")
  })

  it("collapses runs of newlines after stripping", () => {
    const text = 'A\n\n\n<dispatch to="Alice">x</dispatch>\n\n\nB'
    expect(stripDispatches(text)).toBe("A\n\nB")
  })

  it("leaves text alone when no dispatch tags present", () => {
    expect(stripDispatches("hello")).toBe("hello")
  })
})

describe("buildSupervisorRoster", () => {
  const alice = makeCharacter({
    id: "c_alice",
    name: "Alice",
    description: "Researcher",
  })
  const bob = makeCharacter({
    id: "c_bob",
    name: "Bob",
    description: "Critic",
  })

  it("returns empty for empty members", () => {
    expect(buildSupervisorRoster([], new Map())).toBe("")
  })

  it("includes name + role + description per member and the dispatch instruction", () => {
    const slots = new Map<string, TeamMember>([
      ["c_alice", { characterId: "c_alice", role: "Lead" }],
      ["c_bob", { characterId: "c_bob" }],
    ])
    const out = buildSupervisorRoster([alice, bob], slots)
    expect(out).toContain("- Alice (role: Lead) — Researcher")
    expect(out).toContain("- Bob — Critic")
    expect(out).toContain("<dispatch")
  })

  it("truncates descriptions over 80 chars", () => {
    const long = "x".repeat(120)
    const m = makeCharacter({
      id: "c_x",
      name: "Mallory",
      description: long,
    })
    const out = buildSupervisorRoster([m], new Map())
    // The description segment should be exactly 80 'x' characters.
    expect(out).toMatch(/Mallory — x{80}\n/)
  })
})

// ---- Handoff ---------------------------------------------------------------

const ANA = makeCharacter({ id: "char_a", name: "Ana" })
const BEN = makeCharacter({ id: "char_b", name: "Ben" })
const CARA = makeCharacter({ id: "char_c", name: "Cara" })
const ROOM = [ANA, BEN, CARA]

function plan(overrides: Partial<Parameters<typeof planAutoRound>[0]> = {}) {
  return planAutoRound({
    replies: [],
    members: ROOM,
    spokenCount: 1,
    responseCap: 4,
    round: 0,
    maxAutoRounds: 2,
    spokenIds: [],
    ...overrides,
  })
}

describe("parseHandoffTargets", () => {
  it("reads the members an agent's own reply addresses", () => {
    // `parseMentions` only ever ran on the user's text, so an agent writing
    // "@Ben, can you check this?" was addressing nobody.
    expect(parseHandoffTargets("@Ben can you check the migration?", ROOM, "char_a")).toEqual([BEN])
  })

  it("drops a self-mention, which is narration and would loop forever", () => {
    expect(parseHandoffTargets("As @Ana already said, no", ROOM, "char_a")).toEqual([])
  })

  it("keeps every distinct member in the order addressed", () => {
    expect(parseHandoffTargets("@Cara then @Ben please", ROOM, "char_a")).toEqual([CARA, BEN])
  })

  it("finds nothing in a reply that mentions nobody", () => {
    expect(parseHandoffTargets("done, shipping it", ROOM, "char_a")).toEqual([])
  })
})

describe("handoff stop token", () => {
  it("recognises the token the prompt teaches", () => {
    // The prompt is written from the constant, so a drift between the two
    // would be a protocol nothing could catch: the member obeys, the chain
    // runs to its ceiling anyway, and the transcript reads as if it worked.
    expect(hasHandoffStopToken(`we are done ${HANDOFF_STOP_TOKEN}`)).toBe(true)
  })

  it("accepts the shapes a model actually writes", () => {
    expect(hasHandoffStopToken("<stop-handoff>")).toBe(true)
    expect(hasHandoffStopToken("</stop-handoff>")).toBe(true)
    expect(hasHandoffStopToken("<stop-handoff />")).toBe(true)
    expect(hasHandoffStopToken("< STOP-HANDOFF />")).toBe(true)
  })

  it("does not fire on prose about stopping", () => {
    expect(hasHandoffStopToken("I think we should stop handoff rounds here")).toBe(false)
    expect(hasHandoffStopToken("stop-handoff")).toBe(false)
  })

  it("keeps the answer and removes the plumbing", () => {
    expect(stripHandoffStopToken(`Ship it.\n\n${HANDOFF_STOP_TOKEN}`)).toBe("Ship it.")
  })

  it("does not leave a hole where the tag was", () => {
    const text = `First.\n\n${HANDOFF_STOP_TOKEN}\n\n\nSecond.`
    expect(stripHandoffStopToken(text)).toBe("First.\n\nSecond.")
  })

  it("scans repeatedly without the regex losing its place", () => {
    // A module-level /g regex keeps `lastIndex` between calls, which makes
    // every second identical check answer false.
    expect(hasHandoffStopToken(HANDOFF_STOP_TOKEN)).toBe(true)
    expect(hasHandoffStopToken(HANDOFF_STOP_TOKEN)).toBe(true)
  })
})

describe("planAutoRound", () => {
  it("queues the members a reply handed the floor to", () => {
    const result = plan({ replies: [{ characterId: "char_a", text: "@Ben your turn" }] })
    expect(result.targets).toEqual([BEN])
    expect(result.stop).toBeNull()
  })

  it("is off entirely when the team allows no auto rounds", () => {
    const result = plan({
      maxAutoRounds: 0,
      replies: [{ characterId: "char_a", text: "@Ben your turn" }],
    })
    expect(result).toEqual({ targets: [], stop: "budget" })
  })

  it("stops when the round budget is spent", () => {
    const result = plan({
      round: 2,
      maxAutoRounds: 2,
      replies: [{ characterId: "char_a", text: "@Ben your turn" }],
    })
    expect(result.stop).toBe("budget")
  })

  it("stops when the team's response cap is reached", () => {
    const result = plan({
      spokenCount: 4,
      responseCap: 4,
      replies: [{ characterId: "char_a", text: "@Ben your turn" }],
    })
    expect(result.stop).toBe("cap")
  })

  it("truncates to the responses left rather than stopping", () => {
    const result = plan({
      spokenCount: 3,
      responseCap: 4,
      replies: [{ characterId: "char_a", text: "@Ben and @Cara" }],
    })
    expect(result.targets).toEqual([BEN])
    expect(result.stop).toBeNull()
  })

  it("lets a member speak twice, which is what makes a handoff worth having", () => {
    // "A asks B, B answers, A concludes".
    const result = plan({
      replies: [{ characterId: "char_b", text: "@Ana over to you" }],
      spokenIds: ["char_a", "char_b"],
    })
    expect(result.targets).toEqual([ANA])
  })

  it("refuses a third turn, so two agents cannot address each other forever", () => {
    const result = plan({
      replies: [{ characterId: "char_b", text: "@Ana again" }],
      spokenIds: Array.from({ length: MAX_TURNS_PER_MEMBER_PER_ROUND }, () => "char_a"),
    })
    expect(result).toEqual({ targets: [], stop: "repeat" })
  })

  it("ends the chain when a member says the work is finished", () => {
    const result = plan({
      replies: [{ characterId: "char_a", text: "all yours @Ben", stopRequested: true }],
    })
    // The stop wins over the handoff in the same message: a member that closes
    // the thread while naming somebody meant the closing.
    expect(result).toEqual({ targets: [], stop: "token" })
  })

  it("reads the handoffs before the ceilings, so the reason is honest", () => {
    // Ceilings used to be checked first, which reported "budget" for a room
    // where nobody had handed the floor on at all. Nothing was cut off there,
    // and telling the user it was is how a real signal gets ignored.
    const quiet = plan({ maxAutoRounds: 0, replies: [{ characterId: "char_a", text: "done" }] })
    expect(quiet.stop).toBe("no-handoff")

    const capped = plan({
      spokenCount: 4,
      responseCap: 4,
      replies: [{ characterId: "char_a", text: "nothing further" }],
    })
    expect(capped.stop).toBe("no-handoff")
  })

  it("distinguishes a room that went quiet from one that was throttled", () => {
    const quiet = plan({ replies: [{ characterId: "char_a", text: "all done" }] })
    expect(quiet.stop).toBe("no-handoff")
  })

  it("still admits a fresh member when a repeat one is blocked", () => {
    const result = plan({
      replies: [{ characterId: "char_b", text: "@Ana and @Cara" }],
      spokenIds: ["char_a", "char_a"],
    })
    expect(result.targets).toEqual([CARA])
    expect(result.stop).toBeNull()
  })

  it("merges the handoffs of several members without duplicating one", () => {
    const result = plan({
      replies: [
        { characterId: "char_a", text: "@Cara please" },
        { characterId: "char_b", text: "@Cara too" },
      ],
    })
    expect(result.targets).toEqual([CARA])
  })
})

// ---- Room settings in routing (ADR-0177 batch 3) ---------------------------

describe("routeTurn with room options", () => {
  const coder = makeCharacter({ id: "c1", name: "Coder" })
  const writer = makeCharacter({ id: "c2", name: "Writer" })
  const reviewer = makeCharacter({ id: "c3", name: "Reviewer" })
  const members = [coder, writer, reviewer]
  const team = makeTeam({
    members: [{ characterId: "c1" }, { characterId: "c2" }, { characterId: "c3" }],
    orchestration: "round_robin",
  })

  it("never picks a muted member on its own", () => {
    expect(routeTurn(team, members, "hi", undefined, { mutedMemberIds: ["c2"] })).toEqual([
      coder,
      reviewer,
    ])
    const smart = makeTeam({ ...team, orchestration: "mention_round_robin" })
    // The primary router is handed the unmuted candidates, but a stale id
    // still falls through to the first eligible member rather than nobody.
    expect(routeTurn(smart, members, "hi", "c1", { mutedMemberIds: ["c1"] })).toEqual([writer])
  })

  it("still reaches a muted member by @, because that is the user's initiative", () => {
    expect(routeTurn(team, members, "@Writer go", undefined, { mutedMemberIds: ["c2"] })).toEqual([
      writer,
    ])
  })

  it("routes to the composer's picks in pick order, above every policy", () => {
    expect(
      routeTurn(team, members, "@Coder hi", undefined, {
        explicitTargetIds: ["c3", "c2", "c3", "ghost"],
        mutedMemberIds: ["c2"],
        replyMode: "mention_only",
      })
    ).toEqual([reviewer, writer])
  })

  it("answers only a mention in mention_only mode and nobody when asleep", () => {
    expect(routeTurn(team, members, "hello", undefined, { replyMode: "mention_only" })).toEqual([])
    expect(
      routeTurn(team, members, "@Coder hello", undefined, { replyMode: "mention_only" })
    ).toEqual([coder])
    expect(routeTurn(team, members, "@Coder hello", undefined, { replyMode: "asleep" })).toEqual([])
    expect(
      routeTurn(team, members, "hello", undefined, {
        replyMode: "asleep",
        explicitTargetIds: ["c1"],
      })
    ).toEqual([])
  })

  it("changes nothing for a caller that passes no options", () => {
    expect(routeTurn(team, members, "hi")).toEqual(members)
  })
})

describe("planUserTurn", () => {
  const coder = makeCharacter({ id: "c1", name: "Coder" })
  const members = [coder]
  const team = makeTeam({ members: [{ characterId: "c1" }], orchestration: "round_robin" })

  it("names why the room held its tongue", () => {
    expect(planUserTurn(team, members, "hi", undefined, { replyMode: "asleep" })).toEqual({
      targets: [],
      held: "asleep",
    })
    expect(planUserTurn(team, members, "hi", undefined, { replyMode: "mention_only" })).toEqual({
      targets: [],
      held: "mention_only",
    })
    expect(planUserTurn({ ...team, orchestration: "manual" }, members, "hi")).toEqual({
      targets: [],
      held: "manual",
    })
  })

  it("names the hold for a routing result the runner computed itself", () => {
    expect(holdReasonFor(team, [], { replyMode: "asleep" })).toBe("asleep")
    expect(holdReasonFor(team, [coder], { replyMode: "asleep" })).toBeNull()
    expect(holdReasonFor({ orchestration: "manual" }, [])).toBe("manual")
    expect(holdReasonFor({ orchestration: "supervisor" }, [])).toBeNull()
  })

  it("leaves the supervisor loop unnamed, since somebody still answers", () => {
    expect(planUserTurn({ ...team, orchestration: "supervisor" }, members, "hi")).toEqual({
      targets: [],
      held: null,
    })
    expect(planUserTurn(team, members, "hi")).toEqual({ targets: [coder], held: null })
  })
})

describe("stickyResponderOf", () => {
  it("is the last member that spoke, when it is still a candidate", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", metadata: { senderId: "char_a" } },
      { role: "user" },
      { role: "assistant", metadata: { senderId: "char_b" } },
      { role: "user" },
    ]
    expect(stickyResponderOf(messages, ROOM)).toBe(BEN)
    expect(stickyResponderOf(messages, [ANA, CARA])).toBeUndefined()
    expect(stickyResponderOf([{ role: "user" }], ROOM)).toBeUndefined()
  })

  it("skips an assistant turn that names no member", () => {
    const messages = [
      { role: "assistant", metadata: { senderId: "char_a" } },
      { role: "assistant", metadata: {} },
    ]
    expect(stickyResponderOf(messages, ROOM)).toBe(ANA)
  })
})

describe("clampTalkativeness", () => {
  it("reads absent and malformed values as silent and clamps the rest", () => {
    expect(clampTalkativeness(undefined)).toBe(0)
    expect(clampTalkativeness("1")).toBe(0)
    expect(clampTalkativeness(Number.NaN)).toBe(0)
    expect(clampTalkativeness(-1)).toBe(0)
    expect(clampTalkativeness(7)).toBe(1)
    expect(clampTalkativeness(0.4)).toBe(0.4)
  })
})

describe("planAutoRound with a transition graph, mute and talkativeness", () => {
  it("drops a handoff outside the speaker's declared targets", () => {
    const slots = new Map([["char_a", { handoffTargets: ["char_c"] }]])
    const result = plan({ replies: [{ characterId: "char_a", text: "@Ben and @Cara" }], slots })
    expect(result.targets).toEqual([CARA])
  })

  it("lets a member with an empty target list address nobody", () => {
    const slots = new Map([["char_a", { handoffTargets: [] }]])
    const result = plan({ replies: [{ characterId: "char_a", text: "@Ben" }], slots })
    expect(result).toEqual({ targets: [], stop: "no-handoff" })
  })

  it("never hands the floor to a muted member", () => {
    const result = plan({
      replies: [{ characterId: "char_a", text: "@Ben and @Cara" }],
      mutedMemberIds: ["char_b"],
    })
    expect(result.targets).toEqual([CARA])
  })

  it("lets a talkative member chime in on a roll, never the one who just spoke", () => {
    const slots = new Map([
      ["char_a", { talkativeness: 1 }],
      ["char_c", { talkativeness: 0.5 }],
    ])
    const rolls = [0.2]
    const result = plan({
      replies: [{ characterId: "char_a", text: "done here" }],
      slots,
      random: () => rolls.shift() ?? 0.99,
    })
    expect(result.targets).toEqual([CARA])
    expect(result.stop).toBeNull()

    const quiet = plan({
      replies: [{ characterId: "char_a", text: "done here" }],
      slots,
      random: () => 0.9,
    })
    expect(quiet).toEqual({ targets: [], stop: "no-handoff" })
  })

  it("keeps a muted or exhausted member silent whatever its talkativeness", () => {
    const slots = new Map([
      ["char_b", { talkativeness: 1 }],
      ["char_c", { talkativeness: 1 }],
    ])
    const result = plan({
      replies: [{ characterId: "char_a", text: "done" }],
      slots,
      mutedMemberIds: ["char_b"],
      spokenIds: Array.from({ length: MAX_TURNS_PER_MEMBER_PER_ROUND }, () => "char_c"),
      random: () => 0,
    })
    expect(result).toEqual({ targets: [], stop: "no-handoff" })
  })

  it("does not report a spent budget as a cut-off when only chime-ins were left", () => {
    const slots = new Map([["char_b", { talkativeness: 1 }]])
    const result = plan({
      round: 2,
      maxAutoRounds: 2,
      replies: [{ characterId: "char_a", text: "done" }],
      slots,
      random: () => 0,
    })
    expect(result).toEqual({ targets: [], stop: "no-handoff" })
    const handoff = plan({
      round: 2,
      maxAutoRounds: 2,
      replies: [{ characterId: "char_a", text: "@Cara go" }],
      slots,
      random: () => 0,
    })
    expect(handoff).toEqual({ targets: [], stop: "budget" })
  })

  it("puts handoffs before chime-ins when the cap truncates", () => {
    const slots = new Map([["char_b", { talkativeness: 1 }]])
    const result = plan({
      spokenCount: 3,
      responseCap: 4,
      replies: [{ characterId: "char_a", text: "@Cara go" }],
      slots,
      random: () => 0,
    })
    expect(result.targets).toEqual([CARA])
  })
})
