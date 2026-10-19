import {
  composeEffectivePreview,
  SEND_TIME_SECTIONS,
  SYSTEM_PROMPT_SECTION_SEPARATOR,
} from "./effective-preview"

describe("composeEffectivePreview", () => {
  it("lays out every section in send order and joins them as the turn does", () => {
    const preview = composeEffectivePreview({
      base: { characterPrompt: "You are Ada.", appDefault: "Default." },
      agentName: "Ada",
      persona: { tone: "warm" },
      harnessText: "## Standing rules\n\nBe exact.",
      instructions: { section: "## Project instructions\n\nUse pnpm." },
      workspace: { name: "Repo", customInstructions: "Prefer small diffs." },
      mode: { name: "Research", text: "Cite sources." },
      skills: ["Cite sources", "Diagram Design"],
    })
    expect(preview.segments.map((segment) => segment.kind)).toEqual([
      "base",
      "persona",
      "harness",
      "instructions",
      "workspace",
      "mode",
      "skills",
    ])
    expect(preview.segments[0]).toMatchObject({
      baseSource: "character",
      label: "Ada",
      text: "You are Ada.",
    })
    expect(preview.segments[4].text).toBe("## Workspace instructions (Repo)\n\nPrefer small diffs.")
    expect(preview.segments[6]).toEqual({
      kind: "skills",
      items: ["Cite sources", "Diagram Design"],
      chars: 0,
      tokens: 0,
    })
    expect(preview.text.split(SYSTEM_PROMPT_SECTION_SEPARATOR)).toHaveLength(6)
    expect(preview.chars).toBe(preview.text.length)
    expect(preview.tokens).toBeGreaterThan(0)
    expect(preview.omitted).toEqual([])
    expect(preview.sendTime).toBe(SEND_TIME_SECTIONS)
  })

  it("falls back to the app default and says why sections are missing", () => {
    const preview = composeEffectivePreview({
      base: { appDefault: "Default." },
      instructions: { omitted: "bare-mode" },
    })
    expect(preview.segments).toEqual([
      expect.objectContaining({ kind: "base", baseSource: "app-default", text: "Default." }),
    ])
    expect(preview.segments[0].label).toBeUndefined()
    expect(preview.omitted).toEqual([
      { kind: "persona", reason: "empty" },
      { kind: "harness", reason: "empty" },
      { kind: "instructions", reason: "bare-mode" },
      { kind: "workspace", reason: "empty" },
      { kind: "mode", reason: "empty" },
      { kind: "skills", reason: "empty" },
    ])
    expect(preview.text).toBe("Default.")
  })

  it("treats a session's explicit empty prompt as the base, which sends nothing", () => {
    const preview = composeEffectivePreview({
      base: { sessionPrompt: "", characterPrompt: "Ignored." },
      instructions: { section: "" },
    })
    expect(preview.segments).toEqual([])
    expect(preview.omitted[0]).toEqual({ kind: "base", reason: "empty" })
    expect(preview.text).toBe("")
  })
})
