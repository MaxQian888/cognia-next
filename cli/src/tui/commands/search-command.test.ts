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
  it("returns a usage notice when the query is empty", () => {
    expect(searchHandler(ctx("   "))).toEqual({ kind: "notice", message: "Usage: /search <text>" })
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
    expect(body).toContain("**user**")
  })
})

describe("SEARCH_COMMANDS", () => {
  it("registers /search with a find alias", () => {
    expect(SEARCH_COMMANDS[0].name).toBe("search")
    expect(SEARCH_COMMANDS[0].aliases).toContain("find")
  })
})
