import {
  buildMessage,
  buildSession,
  deriveTitle,
  filePart,
  importedMessageId,
  importedSessionId,
  reasoningPart,
  renderTranscriptSeed,
  textPart,
  toolPart,
} from "./to-parts"
import type { StoredMessage } from "@cognia/agent-config-types"

describe("to-parts builders", () => {
  it("builds text and reasoning parts with done state", () => {
    expect(textPart("hi")).toMatchObject({ type: "text", text: "hi", state: "done" })
    expect(reasoningPart("think")).toMatchObject({
      type: "reasoning",
      text: "think",
      state: "done",
    })
  })

  it("builds a resolved tool part with output", () => {
    const p = toolPart({
      name: "Bash",
      toolCallId: "t1",
      input: { cmd: "ls" },
      output: "ok",
    }) as Record<string, unknown>
    expect(p.type).toBe("tool-Bash")
    expect(p.toolCallId).toBe("t1")
    expect(p.state).toBe("output-available")
    expect(p.output).toBe("ok")
  })

  it("routes an errored tool result to errorText and clears output", () => {
    const p = toolPart({ name: "Bash", toolCallId: "t1", output: "boom", isError: true }) as Record<
      string,
      unknown
    >
    expect(p.state).toBe("output-error")
    expect(p.errorText).toBe("boom")
    expect(p.output).toBeUndefined()
  })

  it("leaves state input-available when there is no output", () => {
    const p = toolPart({ name: "Read", toolCallId: "t2", input: {} }) as Record<string, unknown>
    expect(p.state).toBe("input-available")
    expect("output" in p).toBe(false)
  })

  it("builds a data-url file part", () => {
    expect(filePart({ mediaType: "image/png", url: "data:image/png;base64,AAA" })).toMatchObject({
      type: "file",
      mediaType: "image/png",
    })
  })

  it("derives a truncated title and falls back", () => {
    expect(deriveTitle("  hello   world ", "fb")).toBe("hello world")
    expect(deriveTitle("", "fb")).toBe("fb")
    expect(deriveTitle("x".repeat(200), "fb")).toHaveLength(80)
  })

  it("derives stable ids", () => {
    expect(importedSessionId("codex", "abc")).toBe("import:codex:abc")
    expect(importedMessageId("import:codex:abc", 3)).toBe("import:codex:abc:m3")
  })

  it("renders a transcript seed and truncates from the tail", () => {
    const msgs: StoredMessage[] = [
      buildMessage({
        sessionId: "s",
        index: 0,
        role: "user",
        parts: [textPart("hi")],
        createdAt: 1,
      }),
      buildMessage({
        sessionId: "s",
        index: 1,
        role: "assistant",
        parts: [toolPart({ name: "Bash", toolCallId: "t", input: {} })],
        createdAt: 2,
      }),
    ]
    const seed = renderTranscriptSeed(msgs)
    expect(seed).toContain("USER:")
    expect(seed).toContain("[tool: Bash]")
    expect(renderTranscriptSeed(msgs, 4).length).toBeLessThanOrEqual(4)
  })

  it("attaches a transcript branch seed to the built session", () => {
    const msgs: StoredMessage[] = [
      buildMessage({
        sessionId: "s",
        index: 0,
        role: "user",
        parts: [textPart("hi")],
        createdAt: 1,
      }),
    ]
    const session = buildSession({
      id: "import:codex:abc",
      title: "T",
      createdAt: 1,
      updatedAt: 2,
      seedMessages: msgs,
    })
    expect(session.kind).toBe("direct")
    expect(session.branchSeed).toMatchObject({ kind: "transcript" })
    expect(session.branchSeed?.content).toContain("hi")
  })

  it("builds a read-only subagent session with no branchSeed when suppressed", () => {
    const msgs = [
      buildMessage({
        sessionId: "s",
        index: 0,
        role: "user",
        parts: [textPart("hi")],
        createdAt: 1,
      }),
    ]
    const session = buildSession({
      id: "import:claude-code:s:sub:x",
      title: "Sub",
      kind: "subagent",
      suppressSeed: true,
      createdAt: 1,
      updatedAt: 2,
      seedMessages: msgs,
    })
    expect(session.kind).toBe("subagent")
    expect(session.branchSeed).toBeUndefined()
  })
})
