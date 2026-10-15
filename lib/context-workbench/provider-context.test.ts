import type { UIMessage } from "ai"
import { attachResourceContext, withWorkbenchMessageContext } from "./provider-context"
import { gateWorkbenchProviderPayload } from "./provider-payload"

it("uses a session-specific header while other resources retain the generic one", () => {
  expect(attachResourceContext("question", "parent", "Main conversation — reference only")).toBe(
    "[Main conversation — reference only]\nparent\n\n[User instruction]\nquestion"
  )
  expect(attachResourceContext("question", "canvas")).toContain("[Current resource context]")
  expect(attachResourceContext("question", "")).toBe("question")
})

it("puts parent context on only the current provider-visible user message and gates it", () => {
  const messages: UIMessage[] = [
    { id: "old", role: "user", parts: [{ type: "text", text: "earlier" }] },
    { id: "now", role: "user", parts: [{ type: "text", text: "question" }] },
  ]
  const copy = withWorkbenchMessageContext(
    messages,
    "jane@example.com",
    "Main conversation — reference only"
  )
  expect(copy[0]).toBe(messages[0])
  expect(copy[1].parts).toHaveLength(2)
  expect(messages[1].parts).toHaveLength(1)
  const gated = gateWorkbenchProviderPayload({
    content: "question",
    messages: copy,
    sendOptions: {},
  })
  expect(JSON.stringify(gated.messages)).toContain("Main conversation — reference only")
  expect(JSON.stringify(gated.messages)).not.toContain("jane@example.com")
})
