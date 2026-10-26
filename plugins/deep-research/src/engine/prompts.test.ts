import {
  coherenceMessages,
  decideActionMessages,
  DEEP_RESEARCH_PROMPTS,
  defaultSystemPrompt,
  draftAnswerMessages,
  evaluateMessages,
  outlineMessages,
  systemPromptFor,
} from "./prompts"

describe("decideActionMessages", () => {
  it("hard-blocks the answer action when disallowed (budget-forcing)", () => {
    const msgs = decideActionMessages("WORKSPACE", false)
    expect(msgs[1].content).toContain("may NOT answer")
    expect(msgs[1].content).not.toContain('"answer"')
    const allowed = decideActionMessages("WORKSPACE", true)
    expect(allowed[1].content).toContain('"answer"')
  })

  it("embeds the workspace and asks for exactly one JSON action", () => {
    const msgs = decideActionMessages("STATE HERE", true)
    expect(msgs[0].role).toBe("system")
    expect(msgs[0].content).toContain("controller of an iterative")
    expect(msgs[1].content).toContain("STATE HERE")
    expect(msgs[1].content).toContain("ONLY a JSON object")
  })
})

describe("locale wiring", () => {
  it("threads the locale into every model-facing prompt", () => {
    const builders = [
      decideActionMessages("ws", true, "zh-CN"),
      outlineMessages("topic", "landscape", "zh-CN"),
      coherenceMessages("topic", "title", "blocks", "zh-CN"),
      draftAnswerMessages("q", "evidence", false, "zh-CN"),
      evaluateMessages("q", "a", "e", "zh-CN"),
    ]
    for (const msgs of builders) {
      expect(msgs[0].content).toContain("zh-CN")
    }
  })

  it("omits the locale line entirely when unset", () => {
    expect(draftAnswerMessages("q", "e", false)[0].content).not.toContain("locale")
  })
})

describe("outlineMessages", () => {
  it("grounds the outline in the landscape scan and asks for 3-6 sections", () => {
    const msgs = outlineMessages("topic", "the landscape")
    expect(msgs[0].content).toContain("research lead planning a report")
    expect(msgs[1].content).toContain("the landscape")
    expect(msgs[1].content).toContain("sections")
  })
})

describe("coherenceMessages", () => {
  it("tells the model markers are already globally numbered — preserve, don't renumber", () => {
    // Renumbering mid-weave would double-shift every marker the engine already
    // mapped onto the global Sources index.
    const msgs = coherenceMessages("topic", "title", "## H\nbody [3]")
    expect(msgs[0].content).toMatch(/senior analyst assembling/)
    expect(msgs[0].content).toMatch(/EXACTLY as written/)
    expect(msgs[0].content).toMatch(/never.*renumber/i)
    expect(msgs[1].content).toContain("## H\nbody [3]")
    expect(msgs[1].content).toMatch(/Do not append a sources list/)
  })
})

describe("draftAnswerMessages", () => {
  it("asks for inline [n] citations but no model-written sources list", () => {
    // The plugin renders the canonical Sources block itself; a second list in
    // the prose would duplicate it with its own numbering.
    const user = draftAnswerMessages("q", "ev", false)[1].content
    expect(user).toContain("[n] citations")
    expect(user).toMatch(/Do not append a sources list/)
    expect(user).not.toMatch(/End with.*Sources/)
  })

  it("adds the commit-now instruction only in beast mode", () => {
    expect(draftAnswerMessages("q", "e", true)[0].content).toContain("out of research budget")
    expect(draftAnswerMessages("q", "e", false)[0].content).not.toContain("out of research budget")
  })
})

describe("evaluateMessages", () => {
  it("demands a JSON verdict over criteria + evidence", () => {
    const msgs = evaluateMessages("q", "answer", "evidence")
    expect(msgs[0].content).toContain("strict answer evaluator")
    expect(msgs[1].content).toContain('"pass"')
    expect(msgs[1].content).toContain("answer")
  })

  it("fails an answer that papers over contradicting sources", () => {
    // Two sources disagreeing is a fact about the evidence, not a stylistic
    // flaw — the evaluator must call it out rather than accept a one-sided
    // summary.
    expect(evaluateMessages("q", "a", "e")[0].content).toMatch(/contradict/i)
  })
})

describe("freshness anchoring", () => {
  it("anchors the judgment calls on today's date", () => {
    // The model has no clock; without the anchor, "latest" is judged against
    // the training cutoff and stale pages read as current.
    const today = new Date().toISOString().slice(0, 10)
    for (const msgs of [
      decideActionMessages("ws", true),
      outlineMessages("t", "l"),
      draftAnswerMessages("q", "e", false),
      evaluateMessages("q", "a", "e"),
    ]) {
      expect(msgs[0].content).toContain(`Today is ${today}`)
    }
  })
})

describe("editable instructions", () => {
  it("declares one slot per instruction, each default meeting its own fragments", () => {
    const ids = DEEP_RESEARCH_PROMPTS.map((prompt) => prompt.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const prompt of DEEP_RESEARCH_PROMPTS) {
      expect(prompt.title.trim()).not.toBe("")
      for (const fragment of "requiredFragments" in prompt ? prompt.requiredFragments : []) {
        expect(prompt.defaultBody).toContain(fragment)
      }
      // A stray `{{` would make the host refuse the whole declaration.
      expect(prompt.defaultBody).not.toContain("{{")
    }
  })

  it("sends the declared default as the instruction, unchanged", () => {
    expect(
      decideActionMessages("ws", true)[0].content.startsWith(defaultSystemPrompt("decide-action"))
    ).toBe(true)
    expect(outlineMessages("t", "l")[0].content.startsWith(defaultSystemPrompt("outline"))).toBe(
      true
    )
    expect(coherenceMessages("t", "x", "b")[0].content).toBe(defaultSystemPrompt("coherence"))
    expect(draftAnswerMessages("q", "e", true)[0].content).toContain(
      `${defaultSystemPrompt("draft-answer")} ${defaultSystemPrompt("draft-answer-budget")}\nToday is`
    )
    expect(
      evaluateMessages("q", "a", "e")[0].content.startsWith(defaultSystemPrompt("evaluate"))
    ).toBe(true)
  })

  it("keeps the date and locale lines and the user message when the instruction is edited", () => {
    const msgs = decideActionMessages("WS", false, "zh-CN", "Pick one move.")
    expect(msgs[0].content).toMatch(
      /^Pick one move\.\nToday is \d{4}-\d{2}-\d{2}\.\nRespond in the user's locale: zh-CN\.$/
    )
    expect(msgs[1].content).toContain("may NOT answer")
    expect(
      draftAnswerMessages("q", "e", true, undefined, "Answer.", "Commit now.")[0].content
    ).toMatch(/^Answer\. Commit now\.\nToday is/)
  })

  it("resolves through the host, and falls back to the default when it cannot", async () => {
    await expect(systemPromptFor("outline")).resolves.toBe(defaultSystemPrompt("outline"))
    await expect(systemPromptFor("outline", async () => "Edited outline.")).resolves.toBe(
      "Edited outline."
    )
    await expect(
      systemPromptFor("outline", async () => {
        throw new Error("not registered")
      })
    ).resolves.toBe(defaultSystemPrompt("outline"))
  })
})
