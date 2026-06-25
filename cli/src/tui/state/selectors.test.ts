/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

import { createInitialState } from "./initial"
import {
  canSubmit,
  hasInflight,
  hasOverlay,
  isBusy,
  lastAssistantText,
  lastCodeBlock,
  lastToolResultText,
  lastUserText,
  nthAssistantText,
} from "./selectors"
import type { Cell, ToolCell } from "./types"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }
const base = () => createInitialState(config, "ses1")

describe("selectors", () => {
  it("isBusy reflects a non-idle turn", () => {
    expect(isBusy(base())).toBe(false)
    expect(isBusy({ ...base(), turnStatus: "streaming" })).toBe(true)
  })

  it("hasOverlay reflects an open modal", () => {
    expect(hasOverlay(base())).toBe(false)
    expect(hasOverlay({ ...base(), overlay: { kind: "help" } })).toBe(true)
  })

  it("canSubmit requires idle and no overlay", () => {
    expect(canSubmit(base())).toBe(true)
    expect(canSubmit({ ...base(), turnStatus: "streaming" })).toBe(false)
    expect(canSubmit({ ...base(), overlay: { kind: "help" } })).toBe(false)
  })

  it("hasInflight reflects pending text or reasoning", () => {
    expect(hasInflight(base())).toBe(false)
    expect(hasInflight({ ...base(), inflight: { text: "x", thinking: "", tools: [] } })).toBe(true)
    expect(hasInflight({ ...base(), inflight: { text: "", thinking: "y", tools: [] } })).toBe(true)
  })

  it("lastUserText / lastAssistantText find the most recent cell of each kind", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "first" },
      { id: "2", kind: "assistant", raw: "reply one" },
      { id: "3", kind: "user", text: "second" },
      { id: "4", kind: "assistant", raw: "reply two" },
    ]
    const s = { ...base(), cells }
    expect(lastUserText(s)).toBe("second")
    expect(lastAssistantText(s)).toBe("reply two")
  })

  it("lastUserText / lastAssistantText return null when absent", () => {
    expect(lastUserText(base())).toBeNull()
    expect(lastAssistantText(base())).toBeNull()
  })

  it("nthAssistantText walks back N assistant replies", () => {
    const cells: Cell[] = [
      { id: "1", kind: "assistant", raw: "reply one" },
      { id: "2", kind: "user", text: "q" },
      { id: "3", kind: "assistant", raw: "reply two" },
      { id: "4", kind: "assistant", raw: "reply three" },
    ]
    const s = { ...base(), cells }
    expect(nthAssistantText(s, 1)).toBe("reply three")
    expect(nthAssistantText(s, 2)).toBe("reply two")
    expect(nthAssistantText(s, 3)).toBe("reply one")
    expect(nthAssistantText(s, 4)).toBeNull()
  })

  it("nthAssistantText rejects non-positive / non-integer indices", () => {
    const s = { ...base(), cells: [{ id: "1", kind: "assistant", raw: "x" }] as Cell[] }
    expect(nthAssistantText(s, 0)).toBeNull()
    expect(nthAssistantText(s, -1)).toBeNull()
    expect(nthAssistantText(s, 1.5)).toBeNull()
  })

  it("lastCodeBlock returns the last fenced block of the most recent reply with one", () => {
    const cells: Cell[] = [
      { id: "1", kind: "assistant", raw: "older\n```js\nold()\n```" },
      { id: "2", kind: "assistant", raw: "see\n```ts\nfirst()\n```\nand\n```ts\nsecond()\n```" },
      { id: "3", kind: "assistant", raw: "no code here" },
    ]
    expect(lastCodeBlock({ ...base(), cells })).toBe("second()")
  })

  it("lastCodeBlock returns null when no assistant reply has a fenced block", () => {
    const cells: Cell[] = [{ id: "1", kind: "assistant", raw: "plain prose only" }]
    expect(lastCodeBlock({ ...base(), cells })).toBeNull()
    expect(lastCodeBlock(base())).toBeNull()
  })

  it("lastToolResultText returns strings verbatim and other shapes as JSON", () => {
    const strTool: ToolCell = {
      id: "t1",
      kind: "tool",
      callKey: "k1",
      toolName: "bash",
      input: {},
      status: "done",
      result: "plain output",
      collapsed: false,
    }
    expect(lastToolResultText({ ...base(), cells: [strTool] })).toBe("plain output")

    const objTool: ToolCell = { ...strTool, id: "t2", result: { ok: true } }
    expect(lastToolResultText({ ...base(), cells: [objTool] })).toBe(
      JSON.stringify({ ok: true }, null, 2)
    )
  })

  it("lastToolResultText joins text from a content-block array result", () => {
    const tool: ToolCell = {
      id: "t1",
      kind: "tool",
      callKey: "k1",
      toolName: "read",
      input: {},
      status: "done",
      result: [
        { type: "text", text: "line one" },
        { type: "image", source: "..." },
        { type: "text", text: "line two" },
      ],
      collapsed: false,
    }
    expect(lastToolResultText({ ...base(), cells: [tool] })).toBe("line one\nline two")
  })

  it("lastToolResultText falls back to JSON for a block array with no text", () => {
    const tool: ToolCell = {
      id: "t1",
      kind: "tool",
      callKey: "k1",
      toolName: "x",
      input: {},
      status: "done",
      result: [{ type: "image", source: "z" }],
      collapsed: false,
    }
    expect(lastToolResultText({ ...base(), cells: [tool] })).toBe(
      JSON.stringify([{ type: "image", source: "z" }], null, 2)
    )
  })

  it("lastToolResultText skips tools without a result and returns null when none", () => {
    const pending: ToolCell = {
      id: "t1",
      kind: "tool",
      callKey: "k1",
      toolName: "read",
      input: {},
      status: "running",
      collapsed: false,
    }
    expect(lastToolResultText({ ...base(), cells: [pending] })).toBeNull()
    expect(lastToolResultText(base())).toBeNull()
  })
})
