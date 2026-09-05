import { readFileSync } from "node:fs"
import { join } from "node:path"

import { REMOVE_BACKGROUND_PROMPT } from "./prompts"

const REPO_ROOT = join(__dirname, "..", "..", "..")

function source(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8")
}

describe("REMOVE_BACKGROUND_PROMPT", () => {
  it("asks for the subject to be kept, not just the background dropped", () => {
    expect(REMOVE_BACKGROUND_PROMPT).toMatch(/background/i)
    expect(REMOVE_BACKGROUND_PROMPT).toMatch(/subject/i)
  })

  it("is imported by both surfaces rather than copied into either", () => {
    // The two surfaces used to carry byte-identical duplicates. Nothing stopped
    // them drifting, and a scan is the only thing that can catch a future copy
    // being pasted back in.
    for (const file of ["lib/chat/image-edit/ai-service.ts", "lib/plugin/api/media-api.ts"]) {
      const text = source(file)
      expect(text).toContain("REMOVE_BACKGROUND_PROMPT")
      expect(text).not.toContain(REMOVE_BACKGROUND_PROMPT)
    }
  })

  it("is not re-declared anywhere but its own module", () => {
    expect(source("lib/chat/image-edit/prompts.ts")).toContain(REMOVE_BACKGROUND_PROMPT)
  })
})
