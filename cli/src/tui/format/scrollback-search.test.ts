/**
 * @jest-environment node
 */
import type {
  AssistantCell,
  BashCell,
  Cell,
  ErrorCell,
  NoticeCell,
  PlanCell,
  ThinkingCell,
  TodoCell,
  ToolCell,
  UserCell,
} from "../state/types"

import { cellToText, searchCells } from "./scrollback-search"

const user: UserCell = { id: "u1", kind: "user", text: "How do I deploy the worker?" }
const assistant: AssistantCell = {
  id: "a1",
  kind: "assistant",
  raw: "Run `pnpm deploy` then check the worker logs.\nIt may take a minute.",
}

describe("searchCells", () => {
  it("returns hits with the right cellId and an excerpt containing the query", () => {
    const hits = searchCells([user, assistant], "deploy")
    expect(hits).toEqual([
      { cellId: "u1", kind: "user", excerpt: user.text, lineIndex: 0 },
      {
        cellId: "a1",
        kind: "assistant",
        excerpt: "Run `pnpm deploy` then check the worker logs.",
        lineIndex: 0,
      },
    ])
    for (const hit of hits) {
      expect(hit.excerpt.toLowerCase()).toContain("deploy")
    }
  })

  it("matches case-insensitively", () => {
    const hits = searchCells([user], "DEPLOY")
    expect(hits).toHaveLength(1)
    expect(hits[0].cellId).toBe("u1")
  })

  it("returns hits in cell order, one per matching line", () => {
    const hits = searchCells([user, assistant], "worker")
    expect(hits.map((h) => [h.cellId, h.lineIndex])).toEqual([
      ["u1", 0],
      ["a1", 0],
    ])
  })

  it("returns [] when nothing matches", () => {
    expect(searchCells([user, assistant], "kubernetes")).toEqual([])
  })

  it("returns [] for an empty or whitespace-only query", () => {
    expect(searchCells([user], "")).toEqual([])
    expect(searchCells([user], "   ")).toEqual([])
  })

  it("trims long matching lines with ellipses around the hit", () => {
    const longLead = "x".repeat(80)
    const longTail = "y".repeat(200)
    const cell: AssistantCell = {
      id: "long",
      kind: "assistant",
      raw: `${longLead} NEEDLE ${longTail}`,
    }
    const hits = searchCells([cell], "needle")
    expect(hits).toHaveLength(1)
    const { excerpt } = hits[0]
    expect(excerpt.startsWith("…")).toBe(true)
    expect(excerpt.endsWith("…")).toBe(true)
    expect(excerpt.toLowerCase()).toContain("needle")
    expect(excerpt.length).toBeLessThan(cell.raw.length)
  })

  it("keeps a match at the line end un-suffixed when only the lead is trimmed", () => {
    const cell: AssistantCell = {
      id: "tail",
      kind: "assistant",
      raw: `${"q".repeat(200)} NEEDLE`,
    }
    const [hit] = searchCells([cell], "needle")
    expect(hit.excerpt.startsWith("…")).toBe(true)
    expect(hit.excerpt.endsWith("…")).toBe(false)
  })

  it("keeps a match at the line start un-prefixed when only the tail is trimmed", () => {
    const cell: AssistantCell = {
      id: "head",
      kind: "assistant",
      raw: `NEEDLE ${"z".repeat(200)}`,
    }
    const [hit] = searchCells([cell], "needle")
    expect(hit.excerpt.startsWith("…")).toBe(false)
    expect(hit.excerpt.endsWith("…")).toBe(true)
  })
})

describe("cellToText", () => {
  it("extracts user/assistant/thinking text", () => {
    expect(cellToText(user)).toBe(user.text)
    expect(cellToText(assistant)).toBe(assistant.raw)
    const thinking: ThinkingCell = {
      id: "t1",
      kind: "thinking",
      text: "weighing options",
      collapsed: true,
    }
    expect(cellToText(thinking)).toBe("weighing options")
  })

  it("renders a tool cell as header + result body", () => {
    const tool: ToolCell = {
      id: "tool1",
      kind: "tool",
      callKey: "bash:ls",
      toolName: "bash",
      input: { command: "ls -la" },
      status: "done",
      result: "file-a\nfile-b",
      collapsed: true,
    }
    const text = cellToText(tool)
    expect(text).toContain("ls -la")
    expect(text).toContain("file-a")
    // The result is searchable through searchCells too.
    expect(searchCells([tool], "file-b")).toHaveLength(1)
  })

  it("renders an mcp tool cell with a collapsed display name and no result", () => {
    const tool: ToolCell = {
      id: "tool2",
      kind: "tool",
      callKey: "mcp",
      toolName: "mcp__github__create_issue",
      input: {},
      status: "running",
      collapsed: false,
    }
    expect(cellToText(tool)).toBe("github:create_issue")
  })

  it("handles a tool result that is not a plain string", () => {
    const tool: ToolCell = {
      id: "tool3",
      kind: "tool",
      callKey: "k",
      toolName: "grep",
      input: {},
      status: "done",
      result: { matches: ["alpha"] },
      collapsed: true,
    }
    expect(searchCells([tool], "alpha")).toHaveLength(1)
  })

  it("falls back to String() when a tool result is not JSON-serializable", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const tool: ToolCell = {
      id: "tool4",
      kind: "tool",
      callKey: "k",
      toolName: "grep",
      input: {},
      status: "done",
      result: circular,
      collapsed: true,
    }
    // Should not throw; circular object stringifies to "[object Object]".
    expect(searchCells([tool], "object")).toHaveLength(1)
  })

  it("extracts todo contents joined by newline", () => {
    const todo: TodoCell = {
      id: "todo1",
      kind: "todo",
      todos: [
        { content: "Write the matcher", status: "completed" },
        { content: "Wire the overlay", status: "pending" },
      ],
    }
    expect(cellToText(todo)).toBe("Write the matcher\nWire the overlay")
    expect(searchCells([todo], "overlay")).toEqual([
      { cellId: "todo1", kind: "todo", excerpt: "Wire the overlay", lineIndex: 1 },
    ])
  })

  it("extracts error and notice messages", () => {
    const err: ErrorCell = { id: "e1", kind: "error", message: "boom failure" }
    const notice: NoticeCell = { id: "n1", kind: "notice", message: "fresh session" }
    expect(cellToText(err)).toBe("boom failure")
    expect(cellToText(notice)).toBe("fresh session")
    expect(searchCells([err, notice], "session")).toHaveLength(1)
  })

  it("renders a bash cell as command + output, and command-only when empty", () => {
    const bash: BashCell = {
      id: "b1",
      kind: "bash",
      command: "echo hi",
      output: "hi",
      status: "done",
    }
    expect(cellToText(bash)).toBe("echo hi\nhi")
    const noOutput: BashCell = {
      id: "b2",
      kind: "bash",
      command: "true",
      output: "",
      status: "done",
    }
    expect(cellToText(noOutput)).toBe("true")
  })

  it("extracts plan raw markdown", () => {
    const plan: PlanCell = { id: "p1", kind: "plan", raw: "1. step one\n2. step two" }
    expect(cellToText(plan)).toBe("1. step one\n2. step two")
    expect(searchCells([plan], "step two")).toHaveLength(1)
  })

  it("extracts canonical commentary, content, and event cells", () => {
    const cells: Cell[] = [
      { id: "c1", kind: "commentary", messageId: "m1", text: "checking", done: true },
      {
        id: "p1",
        kind: "content-part",
        partId: "part-1",
        part: { type: "custom", customType: "report", summary: "structured content" },
      },
      {
        id: "e1",
        kind: "canonical-event",
        eventId: "event-1",
        level: "warning",
        title: "Runtime warning",
        summary: "retrying",
      },
    ]

    expect(searchCells(cells, "checking")).toHaveLength(1)
    expect(searchCells(cells, "structured content")).toHaveLength(1)
    expect(searchCells(cells, "retrying")).toHaveLength(1)
  })

  it("returns empty text for an unknown kind (defensive default)", () => {
    const weird = { id: "x", kind: "mystery" } as unknown as Cell
    expect(cellToText(weird)).toBe("")
    expect(searchCells([weird], "anything")).toEqual([])
  })
})
