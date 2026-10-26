import { CLI_BASE_IDENTITY_PROMPT } from "./cli-base"
import { validatePromptBody } from "@/lib/prompts/template"

describe("CLI_BASE_IDENTITY_PROMPT", () => {
  it("is a CLI-only runtime baseline whose first line is the identity", () => {
    expect(CLI_BASE_IDENTITY_PROMPT.hosts).toEqual(["cli"])
    expect(CLI_BASE_IDENTITY_PROMPT.kind).toBe("runtime-baseline")
    // The CLI splits the body at the first newline to put `<env>` after the identity.
    expect(CLI_BASE_IDENTITY_PROMPT.defaultBody.split("\n")[0]).toMatch(/^You are Cognia's/)
  })

  it("ships a default that validates against its own contract", () => {
    expect(
      validatePromptBody(CLI_BASE_IDENTITY_PROMPT, CLI_BASE_IDENTITY_PROMPT.defaultBody)
    ).toEqual([])
  })
})
