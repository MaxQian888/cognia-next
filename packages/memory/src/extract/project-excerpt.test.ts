import { projectMiningExcerpt } from "./project-excerpt"

describe("projectMiningExcerpt", () => {
  it("rewrites in-root absolute paths to workspace-relative form", () => {
    expect(
      projectMiningExcerpt("open /Users/me/cognia/lib/db/schema.ts", {
        roots: ["/Users/me/cognia"],
        redact: (t) => t,
      })
    ).toBe("open lib/db/schema.ts")
  })

  it("refuses text that still names a person after normalization", () => {
    // Refusing beats censoring: a claim mined from text we had to cut
    // mid-sentence no longer says what the transcript said.
    expect(
      projectMiningExcerpt("compare with /Users/someone-else/other/app.ts", {
        roots: ["/Users/me/cognia"],
        redact: (t) => t,
      })
    ).toBeUndefined()
  })

  it("normalizes before redacting, so placeholders are never re-parsed as paths", () => {
    const calls: string[] = []
    projectMiningExcerpt("/Users/me/cognia/a.ts", {
      roots: ["/Users/me/cognia"],
      redact: (t) => {
        calls.push(t)
        return t
      },
    })
    expect(calls).toEqual(["a.ts"])
  })

  it("is stable for the same input, which is what makes the hash comparison mean something", () => {
    const options = { roots: ["/Users/me/cognia"], redact: (t: string) => t }
    const first = projectMiningExcerpt("packages/memory pins Rust 1.77.2", options)
    const second = projectMiningExcerpt("packages/memory pins Rust 1.77.2", options)
    expect(first).toBe(second)
  })

  it("redacts PII by default", () => {
    const out = projectMiningExcerpt("ping me at someone@example.com", { roots: [] })
    expect(out).not.toContain("someone@example.com")
  })
})
