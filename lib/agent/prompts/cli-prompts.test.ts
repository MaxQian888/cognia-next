import { resolvePrompt } from "@/lib/prompts/resolve"
import { validatePromptBody } from "@/lib/prompts/template"
import {
  CLI_BASH_ANALYSIS_PROMPT,
  CLI_COMMIT_MESSAGE_PROMPT,
  CLI_FIX_TESTS_PROMPT,
  CLI_HANDOFF_PROMPT,
  CLI_INIT_REWRITE_PROMPT,
  CLI_OCR_VISION_PROMPT,
  CLI_OUTPUT_STYLE_PROMPTS,
  CLI_PLAN_REFINE_PROMPT,
  CLI_PR_SUMMARY_PROMPT,
  CLI_REVIEW_PROMPT,
} from "./cli-prompts"

const ALL = [
  ...Object.values(CLI_OUTPUT_STYLE_PROMPTS),
  CLI_PLAN_REFINE_PROMPT,
  CLI_COMMIT_MESSAGE_PROMPT,
  CLI_PR_SUMMARY_PROMPT,
  CLI_FIX_TESTS_PROMPT,
  CLI_INIT_REWRITE_PROMPT,
  CLI_BASH_ANALYSIS_PROMPT,
  CLI_REVIEW_PROMPT,
  CLI_HANDOFF_PROMPT,
  CLI_OCR_VISION_PROMPT,
]

describe("CLI prompt definitions", () => {
  it("are CLI-only entries with unique ids, workspace-overridable where the cwd is known", () => {
    expect(new Set(ALL.map((def) => def.id)).size).toBe(ALL.length)
    for (const def of ALL) {
      expect(def.hosts).toEqual(["cli"])
      expect(def.scopes).toEqual(
        def === CLI_OCR_VISION_PROMPT ? ["account"] : ["account", "workspace"]
      )
      expect(def.consumers.every((path) => path.startsWith("cli/src/"))).toBe(true)
    }
  })

  it("ship defaults that validate against their own contracts", () => {
    for (const def of ALL) {
      expect({ id: def.id, issues: validatePromptBody(def, def.defaultBody) }).toEqual({
        id: def.id,
        issues: [],
      })
      expect(def.defaultBody.length * 2).toBeLessThanOrEqual(def.maxChars)
    }
  })

  it("keys each output style by the style name its id carries", () => {
    for (const [style, def] of Object.entries(CLI_OUTPUT_STYLE_PROMPTS)) {
      expect(def.id).toBe(`chat.cli.output-style.${style}`)
      expect(def.defaultBody.startsWith("Output style: ")).toBe(true)
    }
  })

  it("keeps the PR summary's parsed markers required", () => {
    expect(CLI_PR_SUMMARY_PROMPT.requiredFragments).toEqual(["Title:", "Body:"])
    expect(
      validatePromptBody(CLI_PR_SUMMARY_PROMPT, "Summarize {{commits}} as a title and body.")
    ).toEqual(
      expect.arrayContaining([
        { code: "missing-fragment", fragment: "Title:" },
        { code: "missing-fragment", fragment: "Body:" },
      ])
    )
  })

  it("never clips a value the builders can produce today", () => {
    // A 12,000-character diff/output plus its truncation marker must render whole.
    const long = "d".repeat(12_100)
    expect(resolvePrompt(CLI_COMMIT_MESSAGE_PROMPT, { values: { diff: long } }).text).toContain(
      long
    )
    expect(resolvePrompt(CLI_FIX_TESTS_PROMPT, { values: { output: long } }).text).toContain(long)
  })
})
