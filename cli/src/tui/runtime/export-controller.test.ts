import { exportSession } from "./export-controller"
import type { TranscriptEntry } from "../../agent/transcript"
import type { TuiAction } from "../state/types"

function harness(entries: TranscriptEntry[]) {
  const actions: TuiAction[] = []
  const writes: Array<{ path: string; content: string }> = []
  return {
    actions,
    writes,
    deps: {
      dispatch: (a: TuiAction) => actions.push(a),
      home: "/home/.cognia",
      sessionId: "sess-1",
      cwd: "/work",
      read: () => entries,
      write: (path: string, content: string) => writes.push({ path, content }),
    },
  }
}

const sample: TranscriptEntry[] = [
  { ts: 1, role: "user", content: "hi" },
  { ts: 2, role: "assistant", content: "hello" },
]

describe("exportSession", () => {
  it("notices and writes nothing for an empty session", async () => {
    const h = harness([])
    await exportSession("md", h.deps)
    expect(h.writes).toHaveLength(0)
    expect(h.actions[0]).toMatchObject({
      type: "NOTICE",
      message: expect.stringMatching(/Nothing to export/),
    })
  })

  it("writes markdown by default and reports the path + count", async () => {
    const h = harness(sample)
    await exportSession("", h.deps)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].path.replace(/\\/g, "/")).toBe("/work/cognia-export-sess-1.md")
    expect(h.writes[0].content).toContain("# Conversation export")
    expect(h.actions.at(-1)).toMatchObject({
      type: "NOTICE",
      message: expect.stringMatching(/2 entries/),
    })
  })

  it("honors an explicit jsonl format", async () => {
    const h = harness(sample)
    await exportSession("jsonl", h.deps)
    expect(h.writes[0].path.replace(/\\/g, "/")).toBe("/work/cognia-export-sess-1.jsonl")
    expect(h.writes[0].content).toBe(`${JSON.stringify(sample[0])}\n${JSON.stringify(sample[1])}\n`)
  })

  it("surfaces a write failure as a notice", async () => {
    const h = harness(sample)
    h.deps.write = () => {
      throw new Error("disk full")
    }
    await exportSession("json", h.deps)
    expect(h.actions.at(-1)).toMatchObject({
      type: "NOTICE",
      message: expect.stringMatching(/Export failed: disk full/),
    })
  })
})
