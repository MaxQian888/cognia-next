import {
  buildSupervisorRoster,
  parseDispatches,
  parseMentions,
  routeTurn,
  stripDispatches,
} from "./team-router"
import type { Character, Team, TeamMember } from "./types"

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

    it("falls back to all members in declared order when no mention", () => {
      expect(routeTurn(team, members, "what do you all think?")).toEqual([coder, writer, reviewer])
    })

    it("respects the team's declared member order over the members-array order", () => {
      const reordered = makeTeam({
        members: [{ characterId: "c3" }, { characterId: "c1" }, { characterId: "c2" }],
        orchestration: "mention_round_robin",
      })
      expect(routeTurn(reordered, members, "anyone?")).toEqual([reviewer, coder, writer])
    })

    it("drops members that no longer exist in the characters list", () => {
      const teamWithGhost = makeTeam({
        members: [{ characterId: "c1" }, { characterId: "c_ghost" }, { characterId: "c2" }],
        orchestration: "mention_round_robin",
      })
      expect(routeTurn(teamWithGhost, members, "go")).toEqual([coder, writer])
    })
  })

  describe("round_robin", () => {
    const team = makeTeam({
      members: [{ characterId: "c1" }, { characterId: "c2" }, { characterId: "c3" }],
      orchestration: "round_robin",
    })

    it("returns all members regardless of mentions", () => {
      expect(routeTurn(team, members, "@Writer only please")).toEqual([coder, writer, reviewer])
    })
  })

  describe("manual", () => {
    const team = makeTeam({
      members: [{ characterId: "c1" }, { characterId: "c2" }],
      orchestration: "manual",
    })

    it("returns an empty list — the user picks", () => {
      expect(routeTurn(team, members, "anyone?")).toEqual([])
      expect(routeTurn(team, members, "@Writer go")).toEqual([])
    })
  })

  describe("supervisor", () => {
    const team = makeTeam({
      members: [{ characterId: "c1" }, { characterId: "c2" }],
      orchestration: "supervisor",
    })

    it("returns nobody — orchestrator drives supervisor flow separately", () => {
      expect(routeTurn(team, members, "anyone?")).toEqual([])
      expect(routeTurn(team, members, "@Writer go")).toEqual([])
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
