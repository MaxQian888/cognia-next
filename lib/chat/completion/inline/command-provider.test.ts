import {
  COMMAND_PROVIDER_ID,
  commandQuery,
  createCommandProvider,
  rankCommandMatches,
} from "./command-provider"
import type { InlineCommandInfo, InlineCompletionContext } from "./types"

const COMMANDS: InlineCommandInfo[] = [
  { name: "compact", description: "Compact the transcript" },
  { name: "clear", description: "Clear the session", aliases: ["reset"] },
  { name: "commit", description: "Commit staged changes" },
]

function ctx(draft: string, commands = COMMANDS): InlineCompletionContext {
  return { draft, caret: draft.length, history: [], commands, surface: "tui" }
}

describe("commandQuery", () => {
  it("returns the text after the slash", () => {
    expect(commandQuery("/comp")).toBe("comp")
  })

  it("returns an empty query for a bare slash", () => {
    expect(commandQuery("/")).toBe("")
  })

  it("returns null when the draft is not a slash line", () => {
    expect(commandQuery("hello")).toBeNull()
  })

  it("returns null once an argument is being typed", () => {
    // `/add-dir /usr` is a command WITH an argument, not a command being named.
    expect(commandQuery("/add-dir /usr")).toBeNull()
  })
})

describe("rankCommandMatches", () => {
  it("completes a command name", () => {
    const out = rankCommandMatches("/comp", COMMANDS)
    expect(out[0].text).toBe("/compact")
    expect(out[0].source).toBe("command")
    expect(out[0].providerId).toBe(COMMAND_PROVIDER_ID)
  })

  it("carries the command description through", () => {
    expect(rankCommandMatches("/comp", COMMANDS)[0].description).toBe("Compact the transcript")
  })

  it("returns nothing for a bare slash rather than guessing", () => {
    // Every command "matches" an empty query, so showing one as ghost text
    // would be arbitrary; the palette is the right surface for that.
    expect(rankCommandMatches("/", COMMANDS)).toEqual([])
  })

  it("returns nothing for a non-slash draft", () => {
    expect(rankCommandMatches("hello", COMMANDS)).toEqual([])
  })

  it("returns nothing when no command shares the prefix", () => {
    expect(rankCommandMatches("/zzz", COMMANDS)).toEqual([])
  })

  it("ignores a command equal to the query (nothing left to complete)", () => {
    expect(rankCommandMatches("/clear", COMMANDS)).toEqual([])
  })

  it("prefers the shortest completion among shared prefixes", () => {
    const commands: InlineCommandInfo[] = [{ name: "pr-comments" }, { name: "pr" }]
    expect(rankCommandMatches("/p", commands)[0].text).toBe("/pr")
  })

  it("completes from an alias", () => {
    const out = rankCommandMatches("/res", COMMANDS)
    expect(out.map((s) => s.text)).toEqual(["/reset"])
  })

  it("ranks a name hit above an alias hit", () => {
    const commands: InlineCommandInfo[] = [
      { name: "xylophone", aliases: ["xenon"] },
      { name: "xenon-real" },
    ]
    const out = rankCommandMatches("/xe", commands)
    expect(out[0].text).toBe("/xenon-real")
  })

  it("completes case-insensitively while preserving the typed case", () => {
    const out = rankCommandMatches("/COMP", COMMANDS)
    expect(out[0].text).toBe("/COMPact")
  })

  it("ranks an exact-case hit above a case-folded one", () => {
    const commands: InlineCommandInfo[] = [{ name: "Alpha" }, { name: "alphabet" }]
    expect(rankCommandMatches("/alp", commands)[0].text).toBe("/alphabet")
  })

  it("honours the limit", () => {
    const out = rankCommandMatches("/c", COMMANDS, { limit: 2 })
    expect(out).toHaveLength(2)
  })

  it("handles an empty command list", () => {
    expect(rankCommandMatches("/comp", [])).toEqual([])
  })
})

describe("createCommandProvider", () => {
  it("is declared synchronous", () => {
    expect(createCommandProvider().sync).toBe(true)
  })

  it("completes from the context command list", async () => {
    const out = await createCommandProvider().getCompletions(
      ctx("/comp"),
      new AbortController().signal
    )
    expect(out.map((s) => s.text)).toEqual(["/compact"])
  })

  it("forwards its options to the matcher", async () => {
    const out = await createCommandProvider({ limit: 1 }).getCompletions(
      ctx("/c"),
      new AbortController().signal
    )
    expect(out).toHaveLength(1)
  })
})
