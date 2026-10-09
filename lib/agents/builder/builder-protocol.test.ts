import { AGENT_BUILDER_TOOL_NAMES } from "@/lib/claude/agent-builder-builtin-tools"
import { AGENT_BUILDER_PROTOCOL } from "./builder-protocol"

describe("AGENT_BUILDER_PROTOCOL", () => {
  it("is a non-empty, session-stable string headed by the builder identity", () => {
    expect(typeof AGENT_BUILDER_PROTOCOL).toBe("string")
    expect(AGENT_BUILDER_PROTOCOL.startsWith("## You are Cognia's Agent Builder")).toBe(true)
  })

  it("names every builder tool it instructs the model to call", () => {
    for (const name of Object.values(AGENT_BUILDER_TOOL_NAMES)) {
      expect(AGENT_BUILDER_PROTOCOL).toContain(name)
    }
  })

  it("tells the model to draft through tools, use catalog ids, and only create on request", () => {
    expect(AGENT_BUILDER_PROTOCOL).toContain("Draft through tools, never in prose")
    expect(AGENT_BUILDER_PROTOCOL).toContain("use only ids it returns")
    expect(AGENT_BUILDER_PROTOCOL).toContain(
      "Only call agent_builder_create_agent when the user asks"
    )
    expect(AGENT_BUILDER_PROTOCOL).toContain("the user will be asked to approve")
  })

  it("forbids approval-skipping permission modes and invented ids, and asks for the user's language", () => {
    expect(AGENT_BUILDER_PROTOCOL).toContain("Never set a permission mode that skips approvals")
    expect(AGENT_BUILDER_PROTOCOL).toContain("never invent ids")
    expect(AGENT_BUILDER_PROTOCOL).toContain("Reply in the user's language")
  })

  it("matches the conversation-starter cap the draft enforces", () => {
    expect(AGENT_BUILDER_PROTOCOL).toContain("up to three short example requests")
  })
})
