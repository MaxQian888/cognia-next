/**
 * @jest-environment node
 *
 * The activity bus must be a safe no-op when there is no DOM (SSR / sidecar).
 */
import { emitAgentActivity, onAgentActivity } from "@/lib/browser/agent-activity"

describe("agent-activity bus without a window", () => {
  it("emit is a no-op and on() returns a no-op unsubscribe", () => {
    expect(typeof window).toBe("undefined")
    const off = onAgentActivity(() => {
      throw new Error("should never fire without a window")
    })
    expect(() => emitAgentActivity("click e1")).not.toThrow()
    expect(() => off()).not.toThrow()
  })
})
