import {
  buildWorkspaceInstructionsSection,
  WORKSPACE_INSTRUCTIONS_MAX_CHARS,
} from "./workspace-instructions"

describe("buildWorkspaceInstructionsSection", () => {
  it("is empty when the workspace has nothing to say", () => {
    expect(buildWorkspaceInstructionsSection(null)).toBe("")
    expect(buildWorkspaceInstructionsSection(undefined)).toBe("")
    expect(buildWorkspaceInstructionsSection({ name: "Work" })).toBe("")
    expect(buildWorkspaceInstructionsSection({ name: "Work", customInstructions: "  \n " })).toBe(
      ""
    )
  })

  it("names the workspace the instructions came from", () => {
    expect(
      buildWorkspaceInstructionsSection({
        name: "Billing",
        customInstructions: "  Use pnpm.\nNever touch prod.  ",
      })
    ).toBe("## Workspace instructions (Billing)\n\nUse pnpm.\nNever touch prod.")
  })

  it("falls back to a bare heading for an unnamed workspace", () => {
    expect(buildWorkspaceInstructionsSection({ name: " ", customInstructions: "x" })).toBe(
      "## Workspace instructions\n\nx"
    )
  })

  it("bounds what one workspace can add to every turn", () => {
    const section = buildWorkspaceInstructionsSection({
      name: "Big",
      customInstructions: "a".repeat(WORKSPACE_INSTRUCTIONS_MAX_CHARS + 500),
    })
    expect(section.endsWith("a".repeat(WORKSPACE_INSTRUCTIONS_MAX_CHARS))).toBe(true)
    expect(section.length).toBe(
      "## Workspace instructions (Big)\n\n".length + WORKSPACE_INSTRUCTIONS_MAX_CHARS
    )
  })
})
