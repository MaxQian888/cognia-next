import type { UIMessage } from "ai"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
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

it("drafts the user's problem from the typed text, not the context envelope", () => {
  // The draft goes into a support report. A snapshot the composer attached is
  // not the user's description of the problem, and it can be a private document.
  const { text } = composeTurnText(
    "typed words",
    [{ kind: "references", text: "SECRET SNAPSHOT" }],
    { nonce: "abcdef0123" }
  )
  const summary = buildSupportConversationSummary(
    [message("u1", "user", text), message("a1", "assistant", "the answer")],
    { user: "User report", support: "Support response" }
  )
  expect(summary).toContain("User report:\ntyped words")
  expect(summary).not.toContain("SECRET SNAPSHOT")
  expect(summary).not.toContain("cognia_context_")
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
