/**
 * Tests for A2UI Prompts
 */

import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests, resolvePrompt } from "@/lib/prompts/resolve"
import { getStandardComponentTypes } from "./catalog"
import { A2UI_PROTOCOL_PROMPT, A2UI_SYSTEM_PROMPT } from "./prompts"

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

describe("A2UI_PROTOCOL_PROMPT", () => {
  it("is the one source of the guidance build-options appends", () => {
    expect(A2UI_SYSTEM_PROMPT).toBe(A2UI_PROTOCOL_PROMPT.defaultBody)
    expect(resolvePrompt(A2UI_PROTOCOL_PROMPT).text).toBe(A2UI_SYSTEM_PROMPT)
  })

  // The parser reads back what this text teaches, so it is inspect-only: a
  // stored override is never applied.
  it("is inspect-only and ignores a stored override", () => {
    expect(A2UI_PROTOCOL_PROMPT).toMatchObject({ operation: "inspect-only", scopes: [] })
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: A2UI_PROTOCOL_PROMPT.id,
          scope: "account",
          targetId: "",
          revisionId: "por-a2ui-protocol",
          body: "Never use A2UI.",
          contractVersion: A2UI_PROTOCOL_PROMPT.contractVersion,
        },
      ])
    )
    expect(resolvePrompt(A2UI_PROTOCOL_PROMPT).text).toBe(A2UI_SYSTEM_PROMPT)
  })

  it("keeps the fragments the parser depends on", () => {
    for (const fragment of A2UI_PROTOCOL_PROMPT.requiredFragments) {
      expect(A2UI_SYSTEM_PROMPT).toContain(fragment)
    }
  })
})

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

  it("teaches the actual Alert, Table, List and Chart renderer fields", () => {
    expect(A2UI_SYSTEM_PROMPT).toContain("\`message\`")
    expect(A2UI_SYSTEM_PROMPT).toContain("\`chartType\`")
    expect(A2UI_SYSTEM_PROMPT).toContain("\`xKey\`")
    expect(A2UI_SYSTEM_PROMPT).toContain("\`yKeys\`")
    expect(A2UI_SYSTEM_PROMPT).not.toContain("**Table**: Data table with `columns` and `rows`")
    expect(A2UI_SYSTEM_PROMPT).not.toContain("**List**: List with `items` array")
  })

  it("includes renderer-valid starting descriptors for every standard catalog type", () => {
    for (const type of getStandardComponentTypes())
      expect(A2UI_SYSTEM_PROMPT).toContain(`"component":"${type}"`)
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
