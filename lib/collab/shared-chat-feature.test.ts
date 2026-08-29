import { assertSharedChatClientEnabled, isSharedChatClientEnabled } from "./shared-chat-feature"

describe("shared chat client rollout gate", () => {
  it("fails closed in production unless explicitly enabled", () => {
    expect(isSharedChatClientEnabled(undefined, "production")).toBe(false)
    expect(isSharedChatClientEnabled("false", "production")).toBe(false)
    expect(isSharedChatClientEnabled("true", "production")).toBe(true)
    expect(isSharedChatClientEnabled(" TRUE ", "production")).toBe(true)
  })

  it("keeps the feature directly testable", () => {
    expect(isSharedChatClientEnabled(undefined, "test")).toBe(true)
    expect(() => assertSharedChatClientEnabled()).not.toThrow()
  })
})
