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
  it("fences a shell result with its language for pager highlighting", () => {
    // bash is a shell tool → fenced as ```bash so DocumentViewer highlights it.
    expect(formatToolResultBody(tool("1", "bash", "line1\nline2"))).toBe(
      "# bash\n\n```bash\nline1\nline2\n```"
    )
  })

  it("shows bash invocation metadata separately from its output", () => {
    const cell = tool("1", "bash", "command rejected", true)
    cell.status = "error"
    cell.input = {
      command: "curl -fsS https://example.com >/dev/null",
      description: "Check service health",
      workdir: "/repo",
      timeout: 5000,
      run_in_background: false,
    }

    const body = formatToolResultBody(cell)
    expect(body).toContain("## Invocation")
    expect(body).toContain("Status: error")
    expect(body).toContain("Mode: foreground")
    expect(body).toContain("Workdir: /repo")
    expect(body).toContain("Timeout: 5000 ms")
    expect(body).toContain("Description: Check service health")
    expect(body).toContain("```bash\ncurl -fsS https://example.com >/dev/null\n```")
    expect(body).toContain("## Output\n\n```text\ncommand rejected\n```")
  })

  it("renders a string result verbatim when no language can be inferred", () => {
    // grep has no detectable result language → no fence, body verbatim.
    expect(formatToolResultBody(tool("1", "grep", "match\nhere"))).toBe("# grep\n\nmatch\nhere")
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
