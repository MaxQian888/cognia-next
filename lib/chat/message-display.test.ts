import { DEFAULT_APPEARANCE_SLICE } from "@/types/appearance"
import { DEFAULTS } from "@/lib/db/settings"
import {
  DEFAULT_MESSAGE_DISPLAY_OPTIONS,
  DEFAULT_MESSAGE_MARKDOWN_OPTIONS,
  resolveMessageDisplayOptions,
} from "./message-display"

describe("resolveMessageDisplayOptions", () => {
  it("uses the balanced preset by default", () => {
    expect(resolveMessageDisplayOptions()).toEqual(DEFAULT_MESSAGE_DISPLAY_OPTIONS)
  })

  it("the settings default slice resolves to the same options as no preference (ADR-0127)", () => {
    // `DEFAULT_APPEARANCE_SLICE.messageDisplay` is spread into canonical
    // DEFAULTS; a fresh install therefore carries `{ preset: "balanced" }` and
    // must resolve identically to a row that has no preference at all.
    expect(resolveMessageDisplayOptions(DEFAULT_APPEARANCE_SLICE.messageDisplay)).toEqual(
      DEFAULT_MESSAGE_DISPLAY_OPTIONS
    )
    expect(DEFAULTS.messageDisplay).toEqual(DEFAULT_APPEARANCE_SLICE.messageDisplay)
    // …and the default row must not carry a legacy agent-flow that would
    // override a chosen preset.
    expect(
      resolveMessageDisplayOptions({ preset: "focused" }, undefined, DEFAULTS.agentFlowMode?.mode)
        .agentFlowMode
    ).toBe(resolveMessageDisplayOptions({ preset: "focused" }).agentFlowMode)
  })

  it("applies preset defaults before global and session overrides", () => {
    expect(
      resolveMessageDisplayOptions(
        { preset: "focused", overrides: { layout: "bubbles", actions: "hover" } },
        { preset: "inspector", overrides: { layout: "cards", actions: "core" } }
      )
    ).toMatchObject({
      preset: "inspector",
      layout: "cards",
      actions: "core",
      agentFlowMode: "detailed",
      reasoning: "expanded",
    })
  })

  it("migrates a valid legacy agent-flow value without overriding an explicit value", () => {
    expect(resolveMessageDisplayOptions(undefined, undefined, "simplified").agentFlowMode).toBe(
      "simplified"
    )
    expect(
      resolveMessageDisplayOptions(
        { preset: "balanced", overrides: { agentFlowMode: "detailed" } },
        undefined,
        "simplified"
      ).agentFlowMode
    ).toBe("detailed")
  })

  it("ignores invalid persisted values", () => {
    expect(
      resolveMessageDisplayOptions({ preset: "nope", overrides: { actions: "wat" } } as never)
    ).toEqual(DEFAULT_MESSAGE_DISPLAY_OPTIONS)
  })

  it("resolves every advanced override and filters invalid individual values", () => {
    const resolved = resolveMessageDisplayOptions({
      preset: "balanced",
      overrides: {
        layout: "cards",
        actions: "hover",
        agentFlowMode: "simplified",
        reasoning: "hidden",
        tools: "collapsed",
        sources: "expanded",
        richControls: "always",
        motion: "expressive",
        metadata: { model: "details", cost: "header" },
      },
    })
    expect(resolved).toMatchObject({
      layout: "cards",
      actions: "hover",
      agentFlowMode: "simplified",
      reasoning: "hidden",
      tools: "collapsed",
      sources: "expanded",
      richControls: "always",
      motion: "expressive",
      metadata: { model: "details", cost: "header" },
    })

    expect(
      resolveMessageDisplayOptions({
        preset: "balanced",
        overrides: {
          layout: "invalid",
          reasoning: "invalid",
          richControls: "invalid",
          motion: "invalid",
          metadata: { model: "invalid" },
        },
      } as never)
    ).toEqual(DEFAULT_MESSAGE_DISPLAY_OPTIONS)
  })

  it("lets an explicit session flow override win over global and legacy values", () => {
    expect(
      resolveMessageDisplayOptions(
        { preset: "focused" },
        { preset: "balanced", overrides: { agentFlowMode: "detailed" } },
        "simplified"
      )
    ).toMatchObject({ preset: "balanced", agentFlowMode: "detailed" })
  })

  describe("markdown / bodyFont knobs (ADR-0127)", () => {
    it("every preset resolves to the pre-ADR renderer behaviour by default", () => {
      for (const preset of ["focused", "balanced", "inspector"] as const) {
        const resolved = resolveMessageDisplayOptions({ preset })
        expect(resolved.markdown).toEqual(DEFAULT_MESSAGE_MARKDOWN_OPTIONS)
        expect(resolved.bodyFont).toBe("sans")
      }
      expect(DEFAULT_MESSAGE_MARKDOWN_OPTIONS).toEqual({
        math: true,
        mermaid: true,
        diff: true,
        codeLineNumbers: true,
        codeWrap: false,
        mathFontScale: 1,
        mathAlign: "center",
        mathCopy: true,
      })
    })

    it("applies partial markdown overrides field-by-field and validates enum values", () => {
      const resolved = resolveMessageDisplayOptions({
        preset: "balanced",
        overrides: {
          markdown: {
            math: false,
            codeWrap: true,
            mathFontScale: 1.2,
            mathAlign: "left",
            // invalid values are ignored, not propagated
            mermaid: "no" as unknown as boolean,
            mathCopy: undefined,
          },
          bodyFont: "serif",
        },
      })
      expect(resolved.markdown).toEqual({
        ...DEFAULT_MESSAGE_MARKDOWN_OPTIONS,
        math: false,
        codeWrap: true,
        mathFontScale: 1.2,
        mathAlign: "left",
      })
      expect(resolved.bodyFont).toBe("serif")
      expect(
        resolveMessageDisplayOptions({
          preset: "balanced",
          overrides: {
            markdown: { mathFontScale: 3 as unknown as 1, mathAlign: "right" as unknown as "left" },
            bodyFont: "mono" as unknown as "sans",
          },
        })
      ).toMatchObject({ markdown: DEFAULT_MESSAGE_MARKDOWN_OPTIONS, bodyFont: "sans" })
    })

    it("session overrides win over global overrides for the new knobs too", () => {
      const resolved = resolveMessageDisplayOptions(
        { preset: "balanced", overrides: { markdown: { mermaid: false }, bodyFont: "serif" } },
        { preset: "balanced", overrides: { markdown: { math: false } } }
      )
      // Session preferences restart from the session preset (existing precedence
      // model), so the global mermaid override does not leak through.
      expect(resolved.markdown.mermaid).toBe(true)
      expect(resolved.markdown.math).toBe(false)
      expect(resolved.bodyFont).toBe("sans")
    })
  })
})
