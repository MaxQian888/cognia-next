import { orchestrationForExecutor, projectBotComposition } from "./project-bot-composition"

describe("orchestrationForExecutor", () => {
  it("derives orchestration from the executor, so the two cannot disagree", () => {
    expect(orchestrationForExecutor("workflow")).toBe("workflow")
    expect(orchestrationForExecutor("squad")).toBe("team")
    expect(orchestrationForExecutor("agent-turn")).toBe("direct")
    // A handler IS the orchestration: whatever it fans out to, it does through
    // the same APIs any caller would.
    expect(orchestrationForExecutor("handler")).toBe("direct")
  })
})

describe("projectBotComposition", () => {
  it("falls back to Standard and background when nothing was configured", () => {
    const { selection, provenance } = projectBotComposition({ executor: "handler" })

    expect(selection.presetId).toBe("standard")
    // Nobody is watching a Bot run type.
    expect(selection.engagement).toBe("background")
    expect(selection.autonomy).toBe("confirm")
    expect("authority" in selection).toBe(false)
    expect(provenance.preset).toBe("system-default")
  })

  it("takes the nearest layer for each axis", () => {
    const { selection, provenance } = projectBotComposition({
      executor: "handler",
      definition: { presetId: "code", autonomy: "act", engagement: "inline" },
      installation: { autonomy: "confirm" },
      request: { engagement: "human" },
    })

    expect(selection.presetId).toBe("code")
    expect(provenance.preset).toBe("definition")
    expect(selection.autonomy).toBe("confirm")
    expect(provenance.autonomy).toBe("installation")
    expect(selection.engagement).toBe("human")
    expect(provenance.engagement).toBe("run-request")
  })

  it("carries the executor's target onto orchestrationRef", () => {
    const { selection, provenance } = projectBotComposition({
      executor: "squad",
      executorRef: "team_1",
    })
    expect(selection.orchestration).toBe("team")
    expect(selection.orchestrationRef).toBe("team_1")
    expect(provenance.orchestration).toBe("definition")
  })

  it("narrows autonomy to the policy ceiling and says so", () => {
    const { selection, provenance } = projectBotComposition({
      executor: "handler",
      definition: { autonomy: "autopilot" },
      policy: { maxAutonomy: "suggest" },
    })

    expect(selection.autonomy).toBe("suggest")
    expect(provenance.autonomy).toBe("policy-ceiling")
  })

  it("keeps the layer as the source when the ceiling did not bite", () => {
    const { provenance } = projectBotComposition({
      executor: "handler",
      definition: { autonomy: "confirm" },
      policy: { maxAutonomy: "act" },
    })
    expect(provenance.autonomy).toBe("definition")
  })

  it("narrows authority to the policy ceiling", () => {
    const { selection, provenance } = projectBotComposition({
      executor: "handler",
      request: { authority: "bypassPermissions" },
      policy: { maxAuthority: "plan" },
    })

    expect(selection.authority).toBe("plan")
    expect(provenance.authority).toBe("policy-ceiling")
  })

  it("applies the ceiling even when no layer asked for an authority", () => {
    const { selection, provenance } = projectBotComposition({
      executor: "handler",
      policy: { maxAuthority: "plan" },
    })
    // A ceiling with nothing under it is still the answer, not silence.
    expect(selection.authority).toBe("plan")
    expect(provenance.authority).toBe("policy-ceiling")
  })

  it("omits authority entirely when neither a layer nor a ceiling names one", () => {
    const { selection } = projectBotComposition({ executor: "handler" })
    // Omitted rather than defaulted, so a preset recommendation still applies.
    expect("authority" in selection).toBe(false)
  })

  it("falls back to Standard for a preset id nothing recognises", () => {
    const { selection, provenance } = projectBotComposition({
      executor: "handler",
      definition: { presetId: "from-a-plugin-that-was-uninstalled" },
      knownPresetIds: new Set(["standard", "code"]),
    })

    expect(selection.presetId).toBe("standard")
    expect(provenance.preset).toBe("system-default")
  })

  it("accepts a preset the catalog knows", () => {
    const { selection, provenance } = projectBotComposition({
      executor: "handler",
      definition: { presetId: "code" },
      knownPresetIds: new Set(["standard", "code"]),
    })
    expect(selection.presetId).toBe("code")
    expect(provenance.preset).toBe("definition")
  })

  it("carries a runtime binding through untouched", () => {
    const { selection } = projectBotComposition({
      executor: "handler",
      runtimeBindingRef: "rt_1",
    })
    expect(selection.runtimeBindingRef).toBe("rt_1")
  })
})
