import { readFileSync } from "node:fs"
import { join } from "node:path"

import { REMOVE_BACKGROUND_PROMPT } from "./prompts"

const REPO_ROOT = join(__dirname, "..", "..", "..")

function source(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8")
}

describe("REMOVE_BACKGROUND_PROMPT", () => {
  it("asks for the subject to be kept, not just the background dropped", () => {
    expect(REMOVE_BACKGROUND_PROMPT.defaultBody).toMatch(/background/i)
    expect(REMOVE_BACKGROUND_PROMPT.defaultBody).toMatch(/subject/i)
  })

  it("is an editable, account-scoped image-model instruction", () => {
    expect(REMOVE_BACKGROUND_PROMPT).toMatchObject({
      id: "generation.image-edit.remove-background",
      kind: "feature-template",
      group: "generation",
      operation: "replace-template",
      scopes: ["account"],
    })
  })

  it("is resolved by both surfaces rather than copied into either", () => {
    // The two surfaces used to carry byte-identical duplicates. Nothing stopped
    // them drifting, and a scan is the only thing that can catch a future copy
    // being pasted back in — or a surface reading the shipped text directly,
    // which would ignore every Prompt Center override.
    for (const file of REMOVE_BACKGROUND_PROMPT.consumers) {
      const text = source(file)
      expect(text).toContain("resolvePromptAsync(REMOVE_BACKGROUND_PROMPT)")
      expect(text).not.toContain(REMOVE_BACKGROUND_PROMPT.defaultBody)
      expect(text).not.toContain("REMOVE_BACKGROUND_PROMPT.defaultBody")
    }
    expect([...REMOVE_BACKGROUND_PROMPT.consumers].sort()).toEqual([
      "lib/chat/image-edit/ai-service.ts",
      "lib/plugin/api/media-api.ts",
    ])
  })

  it("is not re-declared anywhere but its own module", () => {
    expect(source("lib/chat/image-edit/prompts.ts")).toContain(REMOVE_BACKGROUND_PROMPT.defaultBody)
  })

  // The leaf-module rule: importing the provider plane from here recreates the
  // cycle that left the operation handler registry half-initialised.
  it("imports nothing but the dependency-free definition types", () => {
    const imports = source("lib/chat/image-edit/prompts.ts").match(/^import .*$/gm) ?? []
    expect(imports).toEqual(['import { definePrompt } from "@/lib/prompts/types"'])
    expect(source("lib/prompts/types.ts")).not.toMatch(/^import /m)
  })
})
