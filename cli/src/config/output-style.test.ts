import { OUTPUT_STYLES } from "./schema"
import { composeSystemPrompt, outputStyleInstruction } from "./output-style"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import type { PromptDefinitionV1, PromptScope } from "@/lib/prompts/types"
import { CLI_OUTPUT_STYLE_PROMPTS } from "@/lib/agent/prompts/cli-prompts"

describe("outputStyleInstruction", () => {
  it("returns null for default / undefined", () => {
    expect(outputStyleInstruction(undefined)).toBeNull()
    expect(outputStyleInstruction("default")).toBeNull()
  })

  it("returns a non-empty instruction for every non-default style", () => {
    for (const style of OUTPUT_STYLES) {
      if (style === "default") continue
      expect(outputStyleInstruction(style)?.length ?? 0).toBeGreaterThan(0)
    }
  })
})

describe("composeSystemPrompt", () => {
  it("returns the base unchanged for the default style", () => {
    expect(composeSystemPrompt("You are helpful.", "default")).toBe("You are helpful.")
    expect(composeSystemPrompt("You are helpful.", undefined)).toBe("You are helpful.")
  })

  it("appends the style instruction after the base prompt", () => {
    const out = composeSystemPrompt("Base.", "concise")
    expect(out?.startsWith("Base.")).toBe(true)
    expect(out).toContain(outputStyleInstruction("concise")!)
    expect(out).toContain("\n\n")
  })

  it("uses only the style instruction when there is no base prompt", () => {
    expect(composeSystemPrompt(undefined, "learning")).toBe(outputStyleInstruction("learning"))
    expect(composeSystemPrompt("", "learning")).toBe(outputStyleInstruction("learning"))
  })

  it("returns undefined when neither a base nor a style applies", () => {
    expect(composeSystemPrompt(undefined, "default")).toBeUndefined()
    expect(composeSystemPrompt("", undefined)).toBeUndefined()
  })
})

function publishOverride(
  def: PromptDefinitionV1,
  body: string,
  revisionId: string,
  scope: PromptScope = "account",
  targetId = ""
): void {
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot("test-db", [
      {
        bindingId: `pob-${revisionId}`,
        promptId: def.id,
        scope,
        targetId,
        revisionId,
        body,
        contractVersion: def.contractVersion,
      },
    ])
  )
}

describe("output style Prompt Center overrides", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  it("appends a published account override instead of the shipped style", () => {
    publishOverride(CLI_OUTPUT_STYLE_PROMPTS.concise, "Output style: Terse. One line.", "por-os-1")
    expect(composeSystemPrompt("Base.", "concise")).toBe("Base.\n\nOutput style: Terse. One line.")
  })

  it("applies a workspace override only for the workspace mounting the cwd", () => {
    publishOverride(
      CLI_OUTPUT_STYLE_PROMPTS.learning,
      "Output style: Socratic.",
      "por-os-2",
      "workspace",
      "ws-1"
    )
    expect(outputStyleInstruction("learning", { workspaceId: "ws-1" })).toBe(
      "Output style: Socratic."
    )
    expect(outputStyleInstruction("learning", { workspaceId: "ws-2" })).toBe(
      CLI_OUTPUT_STYLE_PROMPTS.learning.defaultBody
    )
  })
})
