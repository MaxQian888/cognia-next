import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type { CanonicalSession } from "@cognia/agent-config-types/canonical-session"

import {
  SESSION_EXPORT_FORMATS,
  exportSession,
  isSessionExportFormat,
  type SessionExportFormat,
} from "./export"

const session: CanonicalSession = {
  header: {
    canonicalVersion: 1,
    canonicalSessionId: "s1",
    sourceRuntime: "builtin",
    title: "Fix <the> bug",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    turnCount: 2,
    importFidelity: "structured",
    sequenceDigest: "seq1-0",
  },
  turns: [
    {
      turnId: "t1:user",
      role: "user",
      text: "run <script>alert(1)</script>",
      at: "2026-01-01T00:00:00.000Z",
    },
    {
      turnId: "t1:assistant",
      role: "assistant",
      text: "done & dusted",
      toolCalls: [
        { callId: "c1", toolName: "Bash", input: { command: "ls" }, resultText: "a\nb" },
        { callId: "c2", toolName: "Write", isError: true, resultText: "denied" },
      ],
    },
    { turnId: "t2:system", role: "system", text: "context reloaded" },
  ],
}

const envelopes: AgentEventEnvelope[] = [
  {
    schemaVersion: 1,
    eventId: "s1:a1:0",
    sequence: 0,
    sessionId: "s1",
    runId: "r1",
    turnId: "t1",
    attemptId: "a1",
    hostRef: "headless-agent-host",
    runtime: "claude-agent-sdk",
    timestamp: "2026-01-01T00:00:00.000Z",
    event: { kind: "user-input", text: "run it" },
  },
]

describe("exportSession", () => {
  it("emits canonical JSON that round-trips", () => {
    const result = exportSession(session, envelopes, { format: "json" })
    expect(result.mediaType).toBe("application/json")
    expect(JSON.parse(result.content)).toEqual(session)
    expect(result.content.endsWith("\n")).toBe(true)
  })

  it("emits the RAW envelope log as JSONL, one envelope per line", () => {
    const result = exportSession(session, envelopes, { format: "jsonl" })
    expect(result.mediaType).toBe("application/x-ndjson")
    const lines = result.content.trimEnd().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toEqual(envelopes[0])
  })

  it("renders markdown with a header block, roles and tool details", () => {
    const result = exportSession(session, envelopes, { format: "markdown" })
    expect(result.mediaType).toBe("text/markdown")
    expect(result.content).toContain("# Fix <the> bug")
    expect(result.content).toContain("- Session: `s1`")
    expect(result.content).toContain("- Import fidelity: structured")
    expect(result.content).toContain("## User")
    expect(result.content).toContain("## Assistant")
    expect(result.content).toContain("## System")
    expect(result.content).toContain("🔧 Bash")
    expect(result.content).toContain("🔧 Write (error)")
    expect(result.content).toContain('"command": "ls"')
  })

  it("omits tool calls from markdown when asked", () => {
    const result = exportSession(session, envelopes, {
      format: "markdown",
      includeToolCalls: false,
    })
    expect(result.content).not.toContain("🔧 Bash")
    expect(result.content).toContain("done & dusted")
  })

  it("escapes every user-controlled string in the HTML export", () => {
    const result = exportSession(session, envelopes, { format: "html" })
    expect(result.mediaType).toBe("text/html")
    expect(result.content).toContain("<!doctype html>")
    expect(result.content).not.toContain("<script>alert(1)</script>")
    expect(result.content).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(result.content).toContain("Fix &lt;the&gt; bug")
    expect(result.content).toContain("done &amp; dusted")
  })

  it("omits tool calls from HTML when asked", () => {
    const result = exportSession(session, envelopes, { format: "html", includeToolCalls: false })
    expect(result.content).not.toContain("🔧 Bash")
  })

  it("falls back to the session id when there is no title", () => {
    const untitled: CanonicalSession = {
      ...session,
      header: { ...session.header, title: undefined },
    }
    expect(exportSession(untitled, envelopes, { format: "markdown" }).content).toContain("# s1")
    expect(exportSession(untitled, envelopes, { format: "html" }).content).toContain(
      "<title>s1</title>"
    )
  })

  it("renders a turn with no text and no tool calls without emitting an empty block", () => {
    const sparse: CanonicalSession = {
      ...session,
      turns: [{ turnId: "t1:assistant", role: "assistant", text: "" }],
    }
    expect(exportSession(sparse, [], { format: "markdown" }).content).toContain("## Assistant")
    expect(exportSession(sparse, [], { format: "html" }).content).not.toContain("<pre></pre>")
  })

  it("covers every declared format", () => {
    for (const format of SESSION_EXPORT_FORMATS) {
      expect(exportSession(session, envelopes, { format }).format).toBe(format)
    }
  })
})

describe("isSessionExportFormat", () => {
  it("accepts the four declared formats and rejects anything else", () => {
    for (const format of SESSION_EXPORT_FORMATS) expect(isSessionExportFormat(format)).toBe(true)
    expect(isSessionExportFormat("pdf" as SessionExportFormat)).toBe(false)
    expect(isSessionExportFormat(1)).toBe(false)
  })
})
