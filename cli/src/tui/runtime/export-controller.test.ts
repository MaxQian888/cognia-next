import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { appendTranscript } from "../../agent/transcript"
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
  it.each(["md", "json", "jsonl"])("exports a real persisted session as %s", async (format) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-export-check-"))
    try {
      appendTranscript(home, "native", { ts: 1, role: "user", content: "exact source" })
      const actions: TuiAction[] = []
      await exportSession(format, {
        home,
        cwd: home,
        sessionId: "native",
        dispatch: (a) => actions.push(a),
      })
      const output = fs.readFileSync(path.join(home, `cognia-export-native.${format}`), "utf8")
      if (format === "md") expect(output).toContain("exact source")
      else
        expect(format === "json" ? JSON.parse(output) : [JSON.parse(output.trim())]).toEqual([
          { ts: 1, role: "user", content: "exact source" },
        ])
      expect(actions[0]).toMatchObject({
        type: "NOTICE",
        message: expect.stringContaining("1 entry"),
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

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

  it("reports read failures without rejecting the command", async () => {
    const h = harness(sample)
    h.deps.read = () => {
      throw new Error("permission denied")
    }
    await expect(exportSession("md", h.deps)).resolves.toBeUndefined()
    expect(h.writes).toHaveLength(0)
    expect(h.actions).toEqual([{ type: "NOTICE", message: "Export failed: permission denied" }])
  })

  it("reports serialization failures without writing partial output", async () => {
    const h = harness([{ ts: 1, role: "assistant", content: "reply", meta: { usage: BigInt(1) } }])
    await expect(exportSession("json", h.deps)).resolves.toBeUndefined()
    expect(h.writes).toHaveLength(0)
    expect(h.actions[0]).toMatchObject({
      type: "NOTICE",
      message: expect.stringContaining("Export failed:"),
    })
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
