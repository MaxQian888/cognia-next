/**
 * @jest-environment jsdom
 */
import { emitAgentActivity, onAgentActivity } from "@/lib/browser/agent-activity"

describe("agent-activity bus", () => {
  it("delivers an emitted action to a subscriber", () => {
    const seen: string[] = []
    const off = onAgentActivity((a) => seen.push(a.action))
    emitAgentActivity("click e1")
    emitAgentActivity("navigate http://localhost/")
    expect(seen).toEqual(["click e1", "navigate http://localhost/"])
    off()
  })

  it("stops delivering after unsubscribe", () => {
    const seen: string[] = []
    const off = onAgentActivity((a) => seen.push(a.action))
    off()
    emitAgentActivity("click e2")
    expect(seen).toEqual([])
  })
})
