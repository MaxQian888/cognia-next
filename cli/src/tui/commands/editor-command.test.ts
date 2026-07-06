import { editorCommand, openCommand, parseOpenTarget } from "./editor-command"
import type { CommandContext } from "./types"
import type { TuiState, ToolCell, Cell } from "../state/types"

function ctx(args: string, cells: Cell[] = []): CommandContext {
  const state = { cells } as unknown as TuiState
  return { state, config: {} as never, version: "0", args }
}

const toolCell = (over: Partial<ToolCell>): ToolCell => ({
  id: "t",
  kind: "tool",
  callKey: "k",
  toolName: "read",
  input: {},
  status: "done",
  collapsed: true,
  ...over,
})

describe("parseOpenTarget", () => {
  it("parses a bare path", () => {
    expect(parseOpenTarget("src/a.ts")).toEqual({ file: "src/a.ts" })
  })

  it("parses file:line and file:line:col", () => {
    expect(parseOpenTarget("a.ts:12")).toEqual({ file: "a.ts", line: 12 })
    expect(parseOpenTarget("a.ts:12:3")).toEqual({ file: "a.ts", line: 12, col: 3 })
  })

  it("keeps a Windows drive colon intact", () => {
    expect(parseOpenTarget("C:\\repo\\a.ts")).toEqual({ file: "C:\\repo\\a.ts" })
    expect(parseOpenTarget("C:\\repo\\a.ts:9")).toEqual({ file: "C:\\repo\\a.ts", line: 9 })
  })
})

describe("/open", () => {
  const run = (args: string, cells: Cell[] = []) => openCommand.handler!(ctx(args, cells))

  it("opens an explicit path with a line", () => {
    expect(run("src/a.ts:5")).toEqual({
      kind: "openFile",
      file: "src/a.ts",
      line: 5,
      col: undefined,
    })
  })

  it("falls back to the last tool file when bare", () => {
    const cells = [
      toolCell({ toolName: "read", input: { file_path: "/x/a.ts", offset: 8 } }),
      toolCell({ toolName: "bash", input: { command: "ls" } }),
    ]
    expect(run("", cells)).toEqual({ kind: "openFile", file: "/x/a.ts", line: 8 })
  })

  it("returns a notice when bare with no file in the transcript", () => {
    expect(run("")).toMatchObject({ kind: "notice" })
  })
})

describe("/editor", () => {
  const run = (args: string) => editorCommand.handler!(ctx(args))

  it("reports editor info when bare", () => {
    expect(run("")).toEqual({ kind: "editorInfo" })
  })

  it("sets the preferred editor when given a command", () => {
    expect(run("cursor")).toEqual({ kind: "setEditor", command: "cursor" })
  })
})
