import { expandHandler, formatToolResultBody, EXPAND_COMMANDS } from "./expand-command"
import type { Cell, ToolCell } from "../state/types"
import type { CommandContext } from "./types"

const tool = (id: string, toolName: string, result: unknown, isError = false): ToolCell =>
  ({
    id,
    kind: "tool",
    callKey: id,
    toolName,
    input: {},
    status: "done",
    result,
    isError,
    collapsed: true,
  }) as ToolCell

function ctx(cells: Cell[], args = ""): CommandContext {
  return { args, state: { cells }, config: {}, version: "0" } as unknown as CommandContext
}

describe("expandHandler", () => {
  it("notices when there is no tool output", () => {
    expect(expandHandler(ctx([{ id: "1", kind: "user", text: "hi" } as never]))).toEqual({
      kind: "notice",
      message: "No tool output to expand yet.",
    })
  })

  it("opens the newest tool result when given no arg", () => {
    const cells = [tool("1", "bash", "old"), tool("2", "read", "newest content")] as Cell[]
    const effect = expandHandler(ctx(cells))
    expect(effect.kind).toBe("openOverlay")
    if (effect.kind === "openOverlay" && effect.overlay.kind === "document") {
      expect(effect.overlay.title).toBe("read output")
      expect(effect.overlay.body).toContain("newest content")
    } else {
      throw new Error("expected document overlay")
    }
  })

  it("opens the n-th tool result (1-based)", () => {
    const cells = [tool("1", "bash", "first"), tool("2", "read", "second")] as Cell[]
    const effect = expandHandler(ctx(cells, "1"))
    if (effect.kind === "openOverlay" && effect.overlay.kind === "document") {
      expect(effect.overlay.body).toContain("first")
    } else {
      throw new Error("expected document overlay")
    }
  })

  it("notices on an out-of-range index", () => {
    const cells = [tool("1", "bash", "x")] as Cell[]
    expect(expandHandler(ctx(cells, "5")).kind).toBe("notice")
    expect(expandHandler(ctx(cells, "0")).kind).toBe("notice")
  })
})

describe("formatToolResultBody", () => {
  it("renders a string result verbatim under a header", () => {
    expect(formatToolResultBody(tool("1", "bash", "line1\nline2"))).toBe("# bash\n\nline1\nline2")
  })

  it("fences a non-string result as json and flags errors", () => {
    const body = formatToolResultBody(tool("1", "read", { a: 1 }, true))
    expect(body).toContain("# read (error)")
    expect(body).toContain("```json")
    expect(body).toContain('"a": 1')
  })

  it("handles a missing result", () => {
    expect(formatToolResultBody(tool("1", "bash", null))).toContain("(no result)")
  })
})

describe("EXPAND_COMMANDS", () => {
  it("registers /expand", () => {
    expect(EXPAND_COMMANDS[0].name).toBe("expand")
  })
})
