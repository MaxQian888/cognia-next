/**
 * Tests for A2UI Prompts
 */

import { A2UI_SYSTEM_PROMPT } from "./prompts"

describe("A2UI_SYSTEM_PROMPT", () => {
  it("should be a non-empty string", () => {
    expect(typeof A2UI_SYSTEM_PROMPT).toBe("string")
    expect(A2UI_SYSTEM_PROMPT.length).toBeGreaterThan(0)
  })

  it("should contain A2UI instructions", () => {
    expect(A2UI_SYSTEM_PROMPT).toContain("A2UI")
  })

  it("should describe component types", () => {
    expect(A2UI_SYSTEM_PROMPT).toContain("Button")
    expect(A2UI_SYSTEM_PROMPT).toContain("Text")
    expect(A2UI_SYSTEM_PROMPT).toContain("Card")
  })

  it("should include JSON format examples", () => {
    expect(A2UI_SYSTEM_PROMPT).toContain("surface")
    expect(A2UI_SYSTEM_PROMPT).toContain("components")
  })

  it("documents every component its own examples/templates use", () => {
    // The Quick Poll example steers the model to RadioGroup — it must appear in the Component Reference so the reference
    // and the examples don't contradict each other (regression guard).
    const reference = A2UI_SYSTEM_PROMPT.slice(A2UI_SYSTEM_PROMPT.indexOf("## Component Reference"))
    expect(reference).toContain("**RadioGroup**")
    expect(reference).toContain("**Radio**")
    // The poll example uses RadioGroup with a string `action` on the Button —
    // confirm the prompt keeps teaching the string-action shape this layer's
    // parser expects (not the connector-layer object action).
    expect(A2UI_SYSTEM_PROMPT).toContain('"component": "RadioGroup"')
    expect(A2UI_SYSTEM_PROMPT).toContain('"action": "submit-poll"')
  })

  it("documents the RichOutput component and its advanced profiles", () => {
    expect(A2UI_SYSTEM_PROMPT).toContain("RichOutput")
    expect(A2UI_SYSTEM_PROMPT).toContain("profileId")
    // One profile id per advanced renderer family must be advertised so the
    // model actually produces payloads the rich-output renderers can show.
    for (const profile of [
      "trends-over-time",
      "category-comparison",
      "part-of-whole",
      "network-graph",
      "3d-visualization",
      "music-audio",
      "physics-math-simulation",
    ]) {
      expect(A2UI_SYSTEM_PROMPT).toContain(profile)
    }
    // ...and the payload field each family reads.
    for (const field of [
      "chartData",
      "networkNodes",
      "networkEdges",
      "scenePrompt",
      "audioPrompt",
      "simulationConfig",
    ]) {
      expect(A2UI_SYSTEM_PROMPT).toContain(field)
    }
  })
})
