import { defineChatMiddleware } from "./define-chat-middleware"

describe("defineChatMiddleware", () => {
  it("returns the chat middleware definition unchanged", () => {
    const def = {
      id: "redact",
      label: "Redact Secrets",
      entry: "src/chat/redact.ts",
      export: "createRedactionMiddleware",
      priority: 20,
      timeoutMs: 1000,
    }

    expect(defineChatMiddleware(def)).toBe(def)
  })
})
