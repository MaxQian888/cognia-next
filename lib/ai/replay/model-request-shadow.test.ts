import { buildModelRequestEvent, containsOnlyDigestsAndRefs } from "./model-request-shadow"
import { isKnownCanonicalAgentEventKind } from "@cognia/agent-config-types/agent-execution"

const BASE = {
  resolved: { systemPrompt: "be helpful", allowedTools: ["Read", "Grep"], model: "claude-opus-5" },
  provider: "anthropic",
  purpose: "turn" as const,
}

describe("buildModelRequestEvent", () => {
  it("emits a known canonical event kind", async () => {
    const event = await buildModelRequestEvent(BASE)
    expect(event.kind).toBe("model-request")
    expect(isKnownCanonicalAgentEventKind(event.kind)).toBe(true)
  })

  it("carries digests, never content", async () => {
    const event = await buildModelRequestEvent(BASE)
    expect(containsOnlyDigestsAndRefs(event)).toBe(true)
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain("be helpful")
    expect(serialized).not.toContain("Read")
  })

  it("changes when the system prompt changes", async () => {
    const before = await buildModelRequestEvent(BASE)
    const after = await buildModelRequestEvent({
      ...BASE,
      resolved: { ...BASE.resolved, systemPrompt: "be terse" },
    })
    expect(after.promptDigest).not.toBe(before.promptDigest)
    expect(after.requestDigest).not.toBe(before.requestDigest)
  })

  it("changes when a tool appears, disappears or moves", async () => {
    const base = await buildModelRequestEvent(BASE)
    const added = await buildModelRequestEvent({
      ...BASE,
      resolved: { ...BASE.resolved, allowedTools: ["Read", "Grep", "Bash"] },
    })
    const reordered = await buildModelRequestEvent({
      ...BASE,
      resolved: { ...BASE.resolved, allowedTools: ["Grep", "Read"] },
    })
    expect(added.toolDigest).not.toBe(base.toolDigest)
    expect(reordered.toolDigest).not.toBe(base.toolDigest)
  })

  it("omits optional identity rather than emitting empty strings", async () => {
    const event = await buildModelRequestEvent(BASE)
    expect(event).not.toHaveProperty("compositionDigest")
    expect(event).not.toHaveProperty("executionFingerprint")
    expect(event).not.toHaveProperty("surfaceRef")
  })

  it("carries composition and execution identity when the turn has them", async () => {
    const event = await buildModelRequestEvent({
      ...BASE,
      compositionDigest: `sha256:${"c".repeat(64)}`,
      executionFingerprint: "aexf1-abc",
      surfaceRef: "asset-1",
    })
    expect(event.compositionDigest).toBe(`sha256:${"c".repeat(64)}`)
    expect(event.executionFingerprint).toBe("aexf1-abc")
    expect(event.surfaceRef).toBe("asset-1")
    expect(containsOnlyDigestsAndRefs(event)).toBe(true)
  })

  it("treats a missing prompt and tool list as empty rather than failing", async () => {
    const event = await buildModelRequestEvent({
      resolved: {},
      provider: "anthropic",
      purpose: "turn",
    })
    expect(event.model).toBe("")
    expect(event.promptDigest).toMatch(/^sha256:/)
    expect(event.toolDigest).toMatch(/^sha256:/)
  })

  it("separates purposes so a title call is not a turn", async () => {
    const turn = await buildModelRequestEvent(BASE)
    const title = await buildModelRequestEvent({ ...BASE, purpose: "title" })
    expect(title.requestDigest).not.toBe(turn.requestDigest)
  })

  it("folds sampling config into the request identity", async () => {
    const base = await buildModelRequestEvent(BASE)
    const hotter = await buildModelRequestEvent({
      ...BASE,
      resolved: { ...BASE.resolved, temperature: 1 },
    })
    expect(hotter.requestDigest).not.toBe(base.requestDigest)
  })
})

describe("containsOnlyDigestsAndRefs", () => {
  it("rejects a payload someone widened with content", () => {
    const leaky = {
      kind: "model-request",
      purpose: "turn",
      provider: "anthropic",
      model: "m",
      requestDigest: "d",
      promptDigest: "d",
      toolDigest: "d",
      systemPrompt: "be helpful",
    } as never
    expect(containsOnlyDigestsAndRefs(leaky)).toBe(false)
  })
})
