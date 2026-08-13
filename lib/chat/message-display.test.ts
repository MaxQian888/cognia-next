import { DEFAULT_MESSAGE_DISPLAY_OPTIONS, resolveMessageDisplayOptions } from "./message-display"

describe("resolveMessageDisplayOptions", () => {
  it("uses the balanced preset by default", () => {
    expect(resolveMessageDisplayOptions()).toEqual(DEFAULT_MESSAGE_DISPLAY_OPTIONS)
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
})
