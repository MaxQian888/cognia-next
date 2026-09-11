import { searchHandler, buildSearchDocument, SEARCH_COMMANDS } from "./search-command"
import type { Cell } from "../state/types"
import type { CommandContext } from "./types"

const cells: Cell[] = [
  { id: "1", kind: "user", text: "fix the parser bug" },
  { id: "2", kind: "assistant", raw: "The parser tokenizes input." },
] as unknown as Cell[]

function ctx(args: string): CommandContext {
  return { args, state: { cells }, config: {}, version: "0" } as unknown as CommandContext
}

describe("searchHandler", () => {
  it("opens a guided query form when the query is empty", () => {
    expect(searchHandler(ctx("   "))).toMatchObject({
      kind: "openForm",
      form: { commandName: "search" },
    })
  })

  it("returns a no-match notice when nothing matches", () => {
    const effect = searchHandler(ctx("zzz"))
    expect(effect).toEqual({ kind: "notice", message: 'No matches for "zzz".' })
  })

  it("opens a document overlay of hits", () => {
    const effect = searchHandler(ctx("parser"))
    expect(effect.kind).toBe("openOverlay")
    if (effect.kind === "openOverlay" && effect.overlay.kind === "document") {
      expect(effect.overlay.title).toBe("Search: parser (2)")
      expect(effect.overlay.body).toContain("2 matches")
      expect(effect.overlay.body).toContain("parser")
    } else {
      throw new Error("expected a document overlay")
    }
  })
})

describe("buildSearchDocument", () => {
  it("uses singular 'match' for a single hit", () => {
    const body = buildSearchDocument("x", [
      { cellId: "1", kind: "user", excerpt: "x", lineIndex: 0 },
    ])
    expect(body).toContain("1 match\n")
    expect(body).toContain("User · message 1 · line 1")
  })
})

describe("SEARCH_COMMANDS", () => {
  it("registers /search with a find alias", () => {
    expect(SEARCH_COMMANDS[0].name).toBe("search")
    expect(SEARCH_COMMANDS[0].aliases).toContain("find")
  })
})

it("localizes results and preserves literal transcript text", () => {
  const context = ctx("parser")
  context.config.locale = "zh-CN"
  const result = searchHandler(context)
  expect(result).toMatchObject({ overlay: { format: "text" } })
  expect(JSON.stringify(result)).toContain("搜索")
  const body = buildSearchDocument(
    "[x]",
    [{ cellId: "1", kind: "user", excerpt: "**[x]**", lineIndex: 3 }],
    "zh-CN"
  )
  expect(body).toContain("**[x]**")
  expect(body).toContain("4")
})

it("round-trips a multiword guided query through the dispatcher", async () => {
  const { registerCommands } = await import("./registry")
  const { dispatchCommand } = await import("./dispatch")
  const { buildArgs } = await import("@/lib/slash-commands/build-args")
  registerCommands(SEARCH_COMMANDS)
  const form = dispatchCommand("/find", ctx(""))
  if (form.kind !== "openForm") throw new Error("expected search form")
  const args = buildArgs(form.form.specs, { query: "parser bug" })
  expect(dispatchCommand(`/search ${args}`, ctx(""))).toMatchObject({
    kind: "openOverlay",
    overlay: { kind: "document", title: "Search: parser bug (1)" },
  })
})
