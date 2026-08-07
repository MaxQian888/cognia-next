import type { UIMessage } from "ai"
import { buildSupportConversationSummary } from "./conversation-draft"

const message = (id: string, role: "user" | "assistant", text: string): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
})

it("builds a bounded draft from the latest user problem and Support response", () => {
  const summary = buildSupportConversationSummary(
    [
      message("u1", "user", "old question"),
      message("a1", "assistant", "old answer"),
      message("u2", "user", "the sidecar stopped"),
      message("a2", "assistant", "the runtime snapshot reports not-ready"),
    ],
    { user: "User report", support: "Support response" }
  )
  expect(summary).toBe(
    "User report:\nthe sidecar stopped\n\nSupport response:\nthe runtime snapshot reports not-ready"
  )
})

it("ignores reasoning and bounds very long visible text", () => {
  const summary = buildSupportConversationSummary(
    [
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "private chain" },
          { type: "text", text: "x".repeat(4_000) },
        ],
      } as UIMessage,
    ],
    { user: "User", support: "Support" }
  )
  expect(summary).not.toContain("private chain")
  expect(summary.length).toBeLessThanOrEqual(2_000)
})
