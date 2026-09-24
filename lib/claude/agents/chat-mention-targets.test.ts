import {
  buildChatMentionTargets,
  chatMentionResolvers,
  resolveTargetAgentId,
} from "./chat-mention-targets"
import type { SubagentMentionTarget } from "./chat-mention-targets"
import { buildRouteTargets } from "@/lib/agent-team/runtime-targets"

// Mock only the subagent source; slugify + parseMentions run for real so the
// handle derivation and the scanner reuse are exercised end-to-end.
const mockResolve = jest.fn()
jest.mock("@/lib/claude/agents/subagents", () => ({
  resolveDispatchableSubagents: () => mockResolve(),
}))

beforeEach(() => {
  mockResolve.mockReset()
})

describe("buildChatMentionTargets", () => {
  it("projects dispatchable subagents to mention targets with slugified handles", () => {
    mockResolve.mockReturnValue([
      {
        id: "workflow-designer",
        def: {
          id: "workflow-designer",
          name: "Workflow Designer",
          description: "Designs flows",
          model: "opus",
        },
      },
      {
        id: "template:my-reviewer",
        def: { id: "template:my-reviewer", name: "My Reviewer", description: "Reviews code" },
      },
    ])
    const targets = buildChatMentionTargets()
    expect(targets).toEqual([
      {
        id: "workflow-designer",
        name: "Workflow Designer",
        description: "Designs flows",
        model: "opus",
        handle: "workflow-designer",
      },
      {
        id: "template:my-reviewer",
        name: "My Reviewer",
        description: "Reviews code",
        model: undefined,
        handle: "my-reviewer",
      },
    ])
  })

  it("falls back to the full id as handle when two names collide", () => {
    mockResolve.mockReturnValue([
      { id: "plugin:reviewer", def: { id: "plugin:reviewer", name: "Reviewer", description: "A" } },
      {
        id: "template:reviewer",
        def: { id: "template:reviewer", name: "Reviewer", description: "B" },
      },
    ])
    const targets = buildChatMentionTargets()
    // Both would slug to "reviewer" → each keeps its unique id as the handle.
    expect(targets.map((t) => t.handle)).toEqual(["plugin:reviewer", "template:reviewer"])
  })

  it("gives a subagent named like a reserved route runtime its id as handle", () => {
    // `@codex` addresses the Codex runtime (lib/chat/turn-route); a subagent
    // that slugs to the same token must not be able to answer it.
    mockResolve.mockReturnValue([
      { id: "plugin:codex", def: { id: "plugin:codex", name: "Codex", description: "" } },
      { id: "template:claude", def: { id: "template:claude", name: "Claude", description: "" } },
      { id: "plugin:other", def: { id: "plugin:other", name: "Other", description: "" } },
    ])
    expect(buildChatMentionTargets().map((t) => t.handle)).toEqual([
      "plugin:codex",
      "template:claude",
      "other",
    ])
  })

  it("returns an empty list when no subagents are registered", () => {
    mockResolve.mockReturnValue([])
    expect(buildChatMentionTargets()).toEqual([])
  })
})

describe("resolveTargetAgentId", () => {
  const targets: SubagentMentionTarget[] = [
    {
      id: "workflow-designer",
      name: "Workflow Designer",
      description: "",
      handle: "workflow-designer",
    },
    { id: "template:my-reviewer", name: "My Reviewer", description: "", handle: "my-reviewer" },
  ]

  it("resolves a leading @handle to its dispatcher id", () => {
    expect(resolveTargetAgentId("@my-reviewer take a look", targets)).toBe("template:my-reviewer")
  })

  it("resolves a mid-sentence @handle", () => {
    expect(resolveTargetAgentId("hey @workflow-designer please help", targets)).toBe(
      "workflow-designer"
    )
  })

  it("takes the FIRST matching mention when several are present", () => {
    expect(resolveTargetAgentId("@workflow-designer and @my-reviewer", targets)).toBe(
      "workflow-designer"
    )
  })

  it("returns null when no @handle matches a known target", () => {
    expect(resolveTargetAgentId("@nobody hello", targets)).toBeNull()
    expect(resolveTargetAgentId("plain message", targets)).toBeNull()
  })

  it("does not match an email address (no whitespace before @)", () => {
    expect(resolveTargetAgentId("mail me at me@my-reviewer", targets)).toBeNull()
  })

  it("does not mutate or depend on the original text", () => {
    const text = "@my-reviewer keep this exact text"
    resolveTargetAgentId(text, targets)
    expect(text).toBe("@my-reviewer keep this exact text")
  })
})

describe("chatMentionResolvers", () => {
  it("resolves a handle to the same subagent ref on every send path", () => {
    // Direct send, steer and room turn all share this factory so a typed
    // `@handle` lands as an identical `subagent` ref whichever path parsed it.
    mockResolve.mockReturnValue([
      {
        id: "template:my-reviewer",
        def: { id: "template:my-reviewer", name: "My Reviewer", description: "Reviews" },
      },
    ])
    const resolvers = chatMentionResolvers()
    expect(resolvers.resolveAgentHandle("my-reviewer")).toEqual({
      kind: "subagent",
      id: "my-reviewer",
      label: "My Reviewer",
    })
    expect(resolvers.resolveAgentHandle("nobody")).toBeNull()
  })

  it("resolves the reserved runtime handles to agent refs, case-insensitively", () => {
    mockResolve.mockReturnValue([])
    const resolvers = chatMentionResolvers()
    expect(resolvers.resolveAgentHandle("codex")).toEqual({
      kind: "agent",
      id: "codex",
      label: "codex",
    })
    expect(resolvers.resolveAgentHandle("Claude")).toEqual({
      kind: "agent",
      id: "claude",
      label: "claude",
    })
  })

  it("resolves a Squad member's handle only when the route targets are passed", () => {
    mockResolve.mockReturnValue([])
    const routeTargets = buildRouteTargets({
      squads: [
        {
          team: { id: "s1", name: "Platform" },
          teammates: [
            {
              id: "tm-1",
              teamId: "s1",
              name: "Critic",
              description: "",
              role: "teammate",
              status: "idle",
              config: {},
              completedTaskIds: [],
              tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              progress: 0,
              createdAt: new Date(),
            },
          ],
        },
      ],
    })
    expect(chatMentionResolvers(routeTargets).resolveAgentHandle("critic")).toEqual({
      kind: "agent",
      id: "critic",
      label: "Critic",
    })
    expect(chatMentionResolvers(routeTargets).resolveAgentHandle("CODEX")).toMatchObject({
      kind: "agent",
      id: "codex",
    })
    // Without the conversation's targets a member handle is not a route.
    expect(chatMentionResolvers().resolveAgentHandle("critic")).toBeNull()
  })
})
