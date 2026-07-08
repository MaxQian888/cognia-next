/**
 * @jest-environment node
 */
import { exportHandoffToCli, type ExportHandoffDeps } from "./export-handoff-to-cli"
import type { UIMessage } from "ai"

function msg(role: UIMessage["role"], text: string): UIMessage {
  return { id: `m_${role}`, role, parts: [{ type: "text", text }] } as UIMessage
}

function deps(extra: Partial<ExportHandoffDeps> = {}): ExportHandoffDeps & {
  writes: Array<{ path: string; content: string }>
  dirs: string[]
} {
  const writes: Array<{ path: string; content: string }> = []
  const dirs: string[] = []
  return {
    resolveHome: async () => "/home/u/.cognia",
    join: async (...parts: string[]) => parts.join("/"),
    ensureDir: async (d) => void dirs.push(d),
    writeTextFile: async (p, c) => void writes.push({ path: p, content: c }),
    now: () => 1000,
    writes,
    dirs,
    ...extra,
  }
}

describe("exportHandoffToCli", () => {
  it("writes the transcript drop and returns the resume command", async () => {
    const d = deps()
    const res = await exportHandoffToCli(
      { sessionId: "s_1", messages: [msg("user", "fix it"), msg("assistant", "done")] },
      d
    )
    expect(res.path).toBe("/home/u/.cognia/handoff/s_1.jsonl")
    expect(res.command).toBe("cognia-agent resume s_1")
    expect(d.dirs[0]).toBe("/home/u/.cognia/handoff")
    const lines = d.writes[0].content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { ts: 1000, role: "user", content: "fix it" },
      { ts: 1001, role: "assistant", content: "done" },
    ])
  })

  it("skips empty (tool-only) messages", async () => {
    const d = deps()
    await exportHandoffToCli(
      {
        sessionId: "s_2",
        messages: [msg("user", "q"), { id: "m_x", role: "assistant", parts: [] } as UIMessage],
      },
      d
    )
    const lines = d.writes[0].content.trim().split("\n")
    expect(lines).toHaveLength(1)
  })

  it("throws when there is nothing to hand off", async () => {
    const d = deps()
    await expect(exportHandoffToCli({ sessionId: "s_3", messages: [] }, d)).rejects.toThrow(
      /no text to hand off/
    )
  })

  it("honours a $COGNIA_HOME-overridden CLI home", async () => {
    const d = deps({ resolveHome: async () => "/custom/cognia-home" })
    const res = await exportHandoffToCli({ sessionId: "s_h", messages: [msg("user", "hi")] }, d)
    expect(res.path).toBe("/custom/cognia-home/handoff/s_h.jsonl")
    expect(d.dirs[0]).toBe("/custom/cognia-home/handoff")
  })

  it("throws (never guesses ~/.cognia) when the CLI home can't be resolved", async () => {
    const d = deps({ resolveHome: async () => null })
    await expect(
      exportHandoffToCli({ sessionId: "s_5", messages: [msg("user", "hi")] }, d)
    ).rejects.toThrow(/could not resolve the cognia CLI home/)
    expect(d.writes).toHaveLength(0)
  })

  it("normalizes unexpected roles to user", async () => {
    const d = deps()
    await exportHandoffToCli(
      {
        sessionId: "s_4",
        messages: [
          { id: "m", role: "data", parts: [{ type: "text", text: "x" }] } as unknown as UIMessage,
        ],
      },
      d
    )
    expect(JSON.parse(d.writes[0].content.trim()).role).toBe("user")
  })
})
