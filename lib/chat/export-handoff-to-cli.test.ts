/**
 * @jest-environment node
 */
import {
  serializeHandoffParts,
  exportHandoffToCli,
  type ExportHandoffDeps,
} from "./export-handoff-to-cli"
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
  it("exports imported session ids using portable encoded filenames and shell-safe commands", async () => {
    const d = deps()
    const result = await exportHandoffToCli(
      { sessionId: "import:codex:id", messages: [msg("user", "continue")] },
      d
    )
    expect(result.path).toContain("import%3Acodex%3Aid.jsonl")
    expect(result.command).toBe("cognia-agent resume 'import:codex:id'")
  })

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
    expect(lines).toMatchObject([
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

  it("preserves rich parts as ordered, bounded transcript markers", async () => {
    const d = deps()
    await exportHandoffToCli(
      {
        sessionId: "s_rich",
        messages: [
          {
            id: "m_rich",
            role: "assistant",
            parts: [
              { type: "text", text: "I inspected the project." },
              { type: "reasoning", text: "Need to inspect the failing test." },
              {
                type: "tool-Bash",
                state: "output-available",
                input: { command: "pnpm test " + "x".repeat(400) },
                output: "1 test passed",
              },
              { type: "code", language: "ts", code: "const ok = true" },
              {
                type: "file",
                filename: "report.pdf",
                mediaType: "application/pdf",
                url: "/uploads/report.pdf",
              },
              { type: "image", alt: "terminal screenshot" },
              { type: "future-part", payload: { useful: true } },
            ],
          } as unknown as UIMessage,
        ],
      },
      d
    )

    const { content } = JSON.parse(d.writes[0].content.trim()) as { content: string }
    expect(content).toContain("I inspected the project.")
    expect(content).toContain("[reasoning]")
    expect(content).not.toContain("Need to inspect the failing test.")
    expect(content).toContain("[tool: Bash]")
    expect(content).toContain("1 test passed")
    expect(content).toContain("```ts\nconst ok = true\n```")
    expect(content).toContain("[attachment: report.pdf]")
    expect(content).toContain("[image: terminal screenshot]")
    expect(content).toContain("[part: future-part]")

    const ordered = [
      "I inspected the project.",
      "[reasoning]",
      "[tool: Bash]",
      "```ts",
      "[attachment: report.pdf]",
      "[image: terminal screenshot]",
      "[part: future-part]",
    ].map((marker) => content.indexOf(marker))
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b))
    expect(
      content.split("\n").find((line) => line.startsWith("[tool: Bash]"))?.length
    ).toBeGreaterThan(240)
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

describe("lossless handoff projection", () => {
  it("preserves multiline tool evidence, pairing, images, and complete UI mirrors", () => {
    const mirror = "view\n".repeat(100)
    const result = serializeHandoffParts(
      [
        {
          type: "dynamic-tool",
          toolName: "test",
          toolCallId: "call-7",
          state: "output-error",
          errorText: "failed\nstack trace",
        },
        {
          type: "tool_result",
          tool_use_id: "call-8",
          status: "interrupted",
          content: "line one\nline two",
        },
        { type: "image", url: "file:///tmp/evidence.png" },
        { type: "a2ui", plainTextMirror: mirror },
      ],
      { losslessDetails: true }
    )
    expect(result).toContain("call-7; output-error")
    expect(result).toContain("failed\nstack trace")
    expect(result).toContain("call-8; interrupted\nline one\nline two")
    expect(result).toContain("file:///tmp/evidence.png")
    expect(result).toContain(mirror.trim())
  })
})
