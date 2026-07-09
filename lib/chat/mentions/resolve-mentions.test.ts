import { resolveMentions } from "./resolve-mentions"
import type { MentionResolvers } from "./resolve-mentions"
import type { ContextRef } from "./types"

const noAgents: MentionResolvers = { resolveAgentHandle: () => null }

const withAgents = (handles: Record<string, ContextRef>): MentionResolvers => ({
  resolveAgentHandle: (name) => handles[name] ?? null,
})

describe("resolveMentions", () => {
  it("returns [] for text without mentions (fast path)", () => {
    expect(resolveMentions("no tokens here", noAgents)).toEqual([])
    expect(resolveMentions("", noAgents)).toEqual([])
  })

  it("captures typed file mentions with the raw token", () => {
    const refs = resolveMentions("please read @src/app.ts and @docs/", noAgents)
    expect(refs).toEqual([
      { kind: "file", id: "src/app.ts", raw: "@src/app.ts" },
      { kind: "file", id: "docs/", raw: "@docs/" },
    ])
  })

  it("resolves known agent handles to their structured kind", () => {
    const refs = resolveMentions(
      "@code-reviewer take a look at @src/app.ts",
      withAgents({
        "code-reviewer": { kind: "subagent", id: "code-reviewer", label: "Code Reviewer" },
      })
    )
    expect(refs).toEqual([
      {
        kind: "subagent",
        id: "code-reviewer",
        label: "Code Reviewer",
        raw: "@code-reviewer",
      },
      { kind: "file", id: "src/app.ts", raw: "@src/app.ts" },
    ])
  })

  it("dedupes repeated mentions of the same target", () => {
    const refs = resolveMentions("@a.ts then @a.ts again", noAgents)
    expect(refs).toHaveLength(1)
  })

  it("ignores a lone @ and email-like text", () => {
    expect(resolveMentions("reach me @ home", noAgents)).toEqual([])
  })

  it("captures mentions inside slash-command args", () => {
    const refs = resolveMentions("/review @src/main.rs please", noAgents)
    expect(refs).toEqual([{ kind: "file", id: "src/main.rs", raw: "@src/main.rs" }])
  })
})
