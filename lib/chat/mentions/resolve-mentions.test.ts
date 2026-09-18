import { resolveMentions, resolveTurnContextRefs } from "./resolve-mentions"
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

// The single contract every send path shares: typed `@…` tokens after the
// envelope is stripped, merged with the composer's token-less citations.
describe("resolveTurnContextRefs", () => {
  const envelope =
    "<cognia_context_ab12cd34>\n" +
    "Context the app attached to the user's message. The user's own message follows after the closing tag.\n\n" +
    "Referenced context:\n@src/quoted-inside.ts\n" +
    "</cognia_context_ab12cd34>"

  it("does not resolve @ tokens quoted inside the preamble envelope", () => {
    const refs = resolveTurnContextRefs(`${envelope}\n\nread @src/real.ts`, noAgents)
    expect(refs).toEqual([{ kind: "file", id: "src/real.ts", raw: "@src/real.ts" }])
  })

  it("merges chip citations with the typed tokens, first occurrence wins", () => {
    const chip: ContextRef = { kind: "entity", id: "session:s1", label: "Sprint planning" }
    const refs = resolveTurnContextRefs("see @src/a.ts", noAgents, [
      chip,
      { kind: "file", id: "src/a.ts" },
    ])
    expect(refs).toEqual([{ kind: "file", id: "src/a.ts", raw: "@src/a.ts" }, chip])
  })

  it("returns the citations alone when the text has no @", () => {
    const chip: ContextRef = { kind: "doc", id: "lark:doc_1", label: "Plan" }
    expect(resolveTurnContextRefs("plain words", noAgents, [chip])).toEqual([chip])
  })

  it("strips the envelope from the first text part of block content only", () => {
    const chip: ContextRef = { kind: "entity", id: "message:s1#m9", label: "turn nine" }
    const refs = resolveTurnContextRefs(
      [
        { type: "text", text: `${envelope}\n\ntyped @src/b.ts` },
        // Later text parts are still scanned — only the ENVELOPE is quoted
        // material; a link-context block's tokens were the old behavior too.
        { type: "text", text: "verbatim @src/link-part.ts" },
      ],
      noAgents,
      [chip]
    )
    expect(refs).toEqual([
      { kind: "file", id: "src/b.ts", raw: "@src/b.ts" },
      { kind: "file", id: "src/link-part.ts", raw: "@src/link-part.ts" },
      chip,
    ])
  })

  it("resolves agent handles through the supplied resolvers", () => {
    const refs = resolveTurnContextRefs(
      "@code-reviewer please",
      withAgents({
        "code-reviewer": { kind: "subagent", id: "code-reviewer", label: "Code Reviewer" },
      })
    )
    expect(refs).toEqual([
      { kind: "subagent", id: "code-reviewer", label: "Code Reviewer", raw: "@code-reviewer" },
    ])
  })
})
