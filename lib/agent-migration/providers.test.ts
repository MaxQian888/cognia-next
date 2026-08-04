import { artifactSupportFor } from "./providers"

describe("artifactSupportFor", () => {
  it("marks Claude commands and all vendor memory as shared", () => {
    expect(artifactSupportFor("claude-code", "commands")).toBe("shared")
    expect(artifactSupportFor("codex", "memory")).toBe("shared")
    expect(artifactSupportFor("opencode", "memory")).toBe("shared")
  })

  it("supports every other requested vendor/artifact pair", () => {
    expect(artifactSupportFor("opencode", "skills")).toBe("supported")
    expect(artifactSupportFor("codex", "settings")).toBe("supported")
  })
})
