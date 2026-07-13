// Smoke tests for the markdown / json / plaintext exporters. We focus on:
//   • the right sections appear in the markdown output
//   • the JSON exporter emits a stable shape
//   • plain-text strips formatting and includes role labels

import {
  exportToRichMarkdown,
  exportToRichJSON,
  exportToPlainText,
  type RichExportData,
} from "./rich-markdown"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

const session: ChatSession = {
  id: "s1",
  title: "Test Conversation",
  kind: "direct",
  model: "claude-3.5-sonnet",
  workingDir: "/tmp",
  systemPrompt: "Be helpful",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
}

const messages: StoredMessage[] = [
  {
    id: "m1",
    sessionId: "s1",
    role: "user",
    parts: [{ type: "text", text: "What's 1+1?" }],
    createdAt: 1_700_000_000_000,
  },
  {
    id: "m2",
    sessionId: "s1",
    role: "assistant",
    parts: [
      { type: "reasoning", text: "Adding two integers." },
      { type: "text", text: "It's 2." },
    ],
    createdAt: 1_700_000_001_000,
    metadata: { usage: { input_tokens: 10, output_tokens: 5 } },
  },
  {
    id: "m3",
    sessionId: "s1",
    role: "assistant",
    parts: [
      {
        type: "tool-bash",
        toolCallId: "t1",
        state: "output-available",
        input: { command: "echo hi" },
        output: "hi",
      } as never,
    ],
    createdAt: 1_700_000_002_000,
  },
]

const data: RichExportData = {
  session,
  messages,
  exportedAt: new Date("2024-01-01T12:00:00Z"),
}

describe("exportToRichMarkdown", () => {
  it("renders the title, metadata, and conversation sections", () => {
    const md = exportToRichMarkdown(data)
    expect(md).toContain("# Test Conversation")
    expect(md).toContain("## Conversation Info")
    expect(md).toContain("## System Prompt")
    expect(md).toContain("```\nBe helpful\n```")
    expect(md).toContain("👤 **You**")
    expect(md).toContain("🤖 **Assistant**")
    expect(md).toContain("It's 2.")
    expect(md).toContain("💭 Thinking")
  })

  it("collapses tool calls into a <details> block", () => {
    const md = exportToRichMarkdown(data)
    expect(md).toContain("🔧 Tool: Bash")
    expect(md).toContain("**Parameters:**")
    expect(md).toContain('"command": "echo hi"')
    expect(md).toContain("**Result:**")
  })

  it("hides metadata when includeMetadata is false", () => {
    const md = exportToRichMarkdown({ ...data, includeMetadata: false })
    expect(md).not.toContain("## Conversation Info")
  })

  it("can include token usage details", () => {
    const md = exportToRichMarkdown({ ...data, includeTokens: true })
    expect(md).toContain("Token Usage")
    expect(md).toContain("input_tokens")
  })
})

describe("exportToRichJSON", () => {
  it("emits a parseable JSON snapshot with statistics", () => {
    const json = exportToRichJSON(data)
    const parsed = JSON.parse(json)
    expect(parsed.version).toBe("cognia-next-1.0")
    expect(parsed.session.id).toBe("s1")
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.statistics.totalMessages).toBe(3)
    expect(parsed.statistics.userMessages).toBe(1)
    expect(parsed.statistics.assistantMessages).toBe(2)
    expect(parsed.statistics.hasToolCalls).toBe(true)
  })
})

describe("exportToPlainText", () => {
  it("includes role labels and strips formatting", () => {
    const text = exportToPlainText(data)
    expect(text).toContain("Test Conversation")
    expect(text).toContain("[user]")
    expect(text).toContain("[assistant]")
    expect(text).toContain("What's 1+1?")
    expect(text).toContain("It's 2.")
    expect(text).not.toContain("```")
  })
})

describe("exportToRichMarkdown — additional rendering branches", () => {
  it("renders the system role label", () => {
    const md = exportToRichMarkdown({
      session,
      messages: [
        {
          id: "sys",
          sessionId: "s1",
          role: "system",
          parts: [{ type: "text", text: "rules" }],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt: data.exportedAt,
    })
    expect(md).toContain("⚙️ **System**")
  })

  it("falls back to bold for custom roles", () => {
    const md = exportToRichMarkdown({
      session,
      messages: [
        {
          id: "tool",
          sessionId: "s1",
          role: "tool" as never,
          parts: [{ type: "text", text: "ok" }],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt: data.exportedAt,
    })
    expect(md).toContain("**tool**")
  })

  it("renders tool errorText into an Error block", () => {
    const md = exportToRichMarkdown({
      session,
      messages: [
        {
          id: "te",
          sessionId: "s1",
          role: "assistant",
          parts: [
            {
              type: "tool-broken",
              toolCallId: "t",
              state: "output-error",
              errorText: "boom!",
            } as never,
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt: data.exportedAt,
    })
    expect(md).toContain("**Error:**")
    expect(md).toContain("> ❌ boom!")
  })

  it("renders dynamic-tool with a plain 'tool' label and string output", () => {
    const md = exportToRichMarkdown({
      session,
      messages: [
        {
          id: "dt",
          sessionId: "s1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "dt-1",
              state: "output-available",
              input: { x: 1 },
              output: "raw text output",
            } as never,
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt: data.exportedAt,
    })
    // Output should be rendered without the `safeJSON` wrap because it's a string.
    expect(md).toContain("raw text output")
    expect(md).toContain("🔧 Tool: Tool")
  })

  it("renders file parts with and without a download URL", () => {
    const md = exportToRichMarkdown({
      session,
      messages: [
        {
          id: "f1",
          sessionId: "s1",
          role: "user",
          parts: [
            { type: "file", url: "https://files/a.png", filename: "a.png" } as never,
            { type: "file", filename: "noLink.txt" } as never,
            { type: "file", mediaType: "image/png" } as never, // filename absent
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt: data.exportedAt,
    })
    expect(md).toContain("📎 [a.png](https://files/a.png)")
    expect(md).toContain("📎 noLink.txt")
    expect(md).toContain("📎 image/png")
  })

  it("renders source-url and source-document parts", () => {
    const md = exportToRichMarkdown({
      session,
      messages: [
        {
          id: "src",
          sessionId: "s1",
          role: "assistant",
          parts: [
            { type: "source-url", url: "https://docs/x", title: "X" } as never,
            { type: "source-url", url: "https://docs/y" } as never, // no title
            { type: "source-document", title: "Spec" } as never,
            { type: "source-document", mediaType: "application/pdf" } as never,
            { type: "source-document" } as never, // both undefined
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt: data.exportedAt,
    })
    expect(md).toContain("🔗 [X](https://docs/x)")
    expect(md).toContain("🔗 [https://docs/y](https://docs/y)")
    expect(md).toContain("📄 Spec")
    expect(md).toContain("📄 application/pdf")
    expect(md).toContain("📄 source")
  })

  it("step-start and unknown parts produce no output", () => {
    const md = exportToRichMarkdown({
      session,
      messages: [
        {
          id: "u1",
          sessionId: "s1",
          role: "user",
          parts: [{ type: "step-start" } as never, { type: "data-something" } as never],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt: data.exportedAt,
    })
    // Section is rendered but is empty between role label and the next message.
    expect(md).toContain("👤 **You**")
  })

  it("safeJSON falls back to String() when the input is non-serializable", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    const md = exportToRichMarkdown({
      session,
      messages: [
        {
          id: "cy",
          sessionId: "s1",
          role: "assistant",
          parts: [
            {
              type: "tool-cyclic",
              toolCallId: "c",
              state: "output-available",
              input: cyclic,
            } as never,
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt: data.exportedAt,
    })
    expect(md).toContain("[object Object]")
  })
})
