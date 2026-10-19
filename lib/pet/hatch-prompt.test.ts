import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import {
  buildHatchPetPrompt,
  HATCH_PET_SPRITE_PROMPT,
  type HatchPetPromptCopy,
} from "./hatch-prompt"

const REPO_ROOT = join(__dirname, "..", "..")

/** The `settings.pet.spriteV2.agentPrompt` messages of one locale, as the component maps them. */
function localeCopy(locale: "en" | "zh-CN"): HatchPetPromptCopy {
  const messages = JSON.parse(
    readFileSync(join(REPO_ROOT, "i18n", "messages", locale, "settings", "pet.json"), "utf8")
  ) as { spriteV2: { agentPrompt: Record<string, string> } }
  const copy = messages.spriteV2.agentPrompt
  return {
    defaultConcept: copy.defaultConcept,
    instruction: copy.instruction,
    concept: (brief) => copy.concept.replace("{concept}", brief),
    qa: copy.qa,
    outputFiles: copy.outputFiles,
    scope: copy.scope,
  }
}

const promptCopy: HatchPetPromptCopy = {
  defaultConcept: "a friendly custom pet",
  instruction: "Use the $hatch-pet skill.",
  concept: (brief: string) => `Pet concept: ${brief}`,
  qa: "Complete QA.",
  outputFiles: "Report output files.",
  scope: "Do not modify Cognia.",
}

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

describe("buildHatchPetPrompt", () => {
  it("builds an explicit hatch-pet task from the translated lines", async () => {
    expect(await buildHatchPetPrompt("a tiny clay fox", promptCopy)).toBe(
      [
        "Use the $hatch-pet skill.",
        "Pet concept: a tiny clay fox",
        "Complete QA.",
        "Report output files.",
        "Do not modify Cognia.",
      ].join("\n")
    )
    expect(await buildHatchPetPrompt(" ", promptCopy)).toContain("a friendly custom pet")
  })

  // The editor shows `defaultBody`; English users get exactly that text.
  it("ships a default identical to the English task", async () => {
    const en = localeCopy("en")
    expect(await buildHatchPetPrompt("a tiny clay fox", en)).toBe(
      HATCH_PET_SPRITE_PROMPT.defaultBody.replace("{{concept}}", "a tiny clay fox")
    )
  })

  it("keeps the shipped task localized when nothing is published", async () => {
    const zh = localeCopy("zh-CN")
    const text = await buildHatchPetPrompt("", zh)
    expect(text.split("\n")[0]).toBe(zh.instruction)
    expect(text).toContain(zh.defaultConcept)
  })

  it("seeds a published override in every locale, with the brief rendered in", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: HATCH_PET_SPRITE_PROMPT.id,
          scope: "account",
          targetId: "",
          revisionId: "por-hatch-pet",
          body: "Run $hatch-pet for {{concept}} in pixel-art style.",
          contractVersion: HATCH_PET_SPRITE_PROMPT.contractVersion,
        },
      ])
    )
    expect(await buildHatchPetPrompt("a fox", promptCopy)).toBe(
      "Run $hatch-pet for a fox in pixel-art style."
    )
    expect(await buildHatchPetPrompt(" ", localeCopy("zh-CN"))).toBe(
      `Run $hatch-pet for ${localeCopy("zh-CN").defaultConcept} in pixel-art style.`
    )
  })
})
