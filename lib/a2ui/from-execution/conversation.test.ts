import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

import { buildConversationPage, extractMessageText, previewText, toolNameOf } from "./conversation"
import type { ExecutionPageLabels } from "./types"

const labels: ExecutionPageLabels = {
  status: "Status",
  trigger: "Trigger",
  duration: "Duration",
  tokens: "Tokens",
  cost: "Cost",
  steps: "Steps",
  succeeded: "Succeeded",
  failed: "Failed",
  stepBreakdown: "Step breakdown",
  stepDuration: "Step duration",
  tokenBurn: "Token burn",
  outputs: "Outputs",
  error: "Error",
  model: "Model",
  messages: "Messages",
  user: "User",
  assistant: "Assistant",
  toolCalls: "Tool calls",
  turns: "Turns",
  turn: "Turn",
  role: "Role",
  preview: "Preview",
  finalOutput: "Final output",
  summary: "Summary",
  insights: "Insights",
  untitled: "Untitled",
  unknown: "Unknown",
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "Plan trip",
    kind: "direct",
    model: "claude-opus-4-8",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as ChatSession
}

function msg(role: "user" | "assistant", parts: StoredMessage["parts"]): StoredMessage {
  return {
    id: `m-${Math.random()}`,
    sessionId: "s1",
    role,
    parts,
    createdAt: 0,
  } as unknown as StoredMessage
}

const textPart = (text: string) => ({ type: "text", text }) as StoredMessage["parts"][number]
const toolPart = (name: string) =>
  ({ type: `tool-${name}` }) as unknown as StoredMessage["parts"][number]

describe("extractMessageText", () => {
  it("joins text and reasoning, ignores tool parts", () => {
    const parts = [
      textPart("Hello"),
      { type: "reasoning", text: "thinking" } as StoredMessage["parts"][number],
      toolPart("bash"),
    ]
    expect(extractMessageText(parts)).toBe("Hello\nthinking")
  })
})

describe("toolNameOf", () => {
  it("strips the tool- prefix and maps dynamic-tool", () => {
    expect(toolNameOf(toolPart("bash"))).toBe("bash")
    expect(toolNameOf({ type: "dynamic-tool" } as StoredMessage["parts"][number])).toBe("tool")
  })
})

describe("previewText", () => {
  it("collapses whitespace and truncates", () => {
    expect(previewText("a\n  b   c")).toBe("a b c")
    expect(previewText("x".repeat(200), 10)).toBe(`${"x".repeat(10)}…`)
  })
})

describe("buildConversationPage", () => {
  const messages = [
    msg("user", [textPart("Find me a flight")]),
    msg("assistant", [
      toolPart("web_search"),
      toolPart("web_search"),
      textPart("Here are options"),
    ]),
    msg("user", [textPart("Book the first")]),
    msg("assistant", [toolPart("book"), textPart("Booked!")]),
  ]

  it("derives id, name and description", () => {
    const app = buildConversationPage(
      { kind: "conversation", session: session(), messages },
      labels
    )
    expect(app.id).toBe("convo-page-s1")
    expect(app.name).toBe("Plan trip")
    expect(app.description).toContain("Messages: 4")
    expect(app.description).toContain("Tool calls: 3")
  })

  it("emits KPI tiles with correct user/assistant/tool counts", () => {
    const app = buildConversationPage(
      { kind: "conversation", session: session(), messages },
      labels
    )
    const headings = app.components.filter(
      (c) => c.component === "Text" && (c as { variant?: string }).variant === "heading3"
    )
    // KPI values are heading3 texts: 4 (messages), 2 (user), 2 (assistant), 3 (tools) + final output heading
    const values = headings.map((h) => (h as { text: string }).text)
    expect(values).toEqual(expect.arrayContaining(["4", "2", "3"]))
  })

  it("builds a turn table and a tool-usage table + chart", () => {
    const app = buildConversationPage(
      { kind: "conversation", session: session(), messages },
      labels
    )
    const tables = app.components.filter((c) => c.component === "Table") as Array<{
      data: Record<string, unknown>[]
    }>
    expect(tables.length).toBe(2) // turns + tool summary
    expect(tables[0].data).toHaveLength(4)
    const chart = app.components.find((c) => c.component === "Chart") as {
      chartType: string
      data: unknown[]
    }
    expect(chart.chartType).toBe("bar")
    expect(chart.data).toEqual(expect.arrayContaining([{ name: "web_search", value: 2 }]))
  })

  it("captures the last assistant text as final output", () => {
    const app = buildConversationPage(
      { kind: "conversation", session: session(), messages },
      labels
    )
    const bodyTexts = app.components.filter(
      (c) => c.component === "Text" && (c as { variant?: string }).variant === "body"
    )
    expect(bodyTexts.some((t) => (t as { text: string }).text === "Booked!")).toBe(true)
  })

  it("renders an empty preview for a turn with no text and no tools", () => {
    const app = buildConversationPage(
      { kind: "conversation", session: session(), messages: [msg("user", [])] },
      labels
    )
    const table = app.components.find((c) => c.component === "Table") as {
      data: Record<string, unknown>[]
    }
    expect(table.data[0].preview).toBe("")
  })

  it("falls back to untitled and handles a tool-only conversation", () => {
    const app = buildConversationPage(
      {
        kind: "conversation",
        session: session({ title: "" }),
        messages: [msg("assistant", [toolPart("bash")])],
      },
      labels
    )
    expect(app.name).toBe("Untitled")
    const table = app.components.find((c) => c.component === "Table") as {
      data: Record<string, unknown>[]
    }
    expect(table.data[0].preview).toBe("(Tool calls)")
  })
})
