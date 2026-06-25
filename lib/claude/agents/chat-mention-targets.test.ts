import { buildChatMentionTargets, resolveTargetAgentId } from "./chat-mention-targets"
import type { SubagentMentionTarget } from "./chat-mention-targets"

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
