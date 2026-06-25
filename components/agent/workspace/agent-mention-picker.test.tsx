import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  AgentMentionRow,
  SubagentMentionRow,
  filterMentionables,
  filterSubagents,
} from "./agent-mention-picker"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { SubagentMentionTarget } from "@/lib/claude/agents/chat-mention-targets"

const i18n = {
  agentTeamsWorkspace: {
    chat: {
      virtualTag: "Virtual",
      runtime: {
        claude: "Claude",
        codex: "Codex",
        claudeCode: "Claude Code",
        geminiCli: "Gemini",
        cursorCli: "Cursor",
      },
    },
  },
}

const virtualClaude: MentionTarget = {
  kind: "virtual",
  id: "__virtual_claude__",
  name: "claude",
  runtime: "claude",
  description: "Anthropic Claude API",
}

const virtualCodex: MentionTarget = {
  kind: "virtual",
  id: "__virtual_codex__",
  name: "codex",
  runtime: "codex",
  description: "OpenAI Codex CLI",
}

const teammateAlice: MentionTarget = {
  kind: "teammate",
  id: "tm-1",
  name: "Alice",
  runtime: "claude",
  description: "Frontend specialist",
  nameCollision: false,
  // teammate object is not used by the renderer
  teammate: { name: "Alice" } as never,
}

function renderRow(target: MentionTarget, highlighted = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={i18n} timeZone="UTC">
      <AgentMentionRow target={target} highlighted={highlighted} />
    </NextIntlClientProvider>
  )
}

describe("AgentMentionRow", () => {
  it("renders the @name + runtime badge for a virtual target", () => {
    renderRow(virtualClaude)
    const row = screen.getByTestId("agent-mention-row-__virtual_claude__")
    expect(row).toHaveAttribute("data-virtual", "true")
    expect(screen.getByText("@claude")).toBeInTheDocument()
    expect(screen.getByText("Claude")).toBeInTheDocument()
    expect(screen.getByText("Anthropic Claude API")).toBeInTheDocument()
    expect(screen.getByText("Virtual")).toBeInTheDocument()
  })

  it("renders teammate without the virtual chip", () => {
    renderRow(teammateAlice)
    const row = screen.getByTestId("agent-mention-row-tm-1")
    expect(row).toHaveAttribute("data-virtual", "false")
    expect(screen.queryByText("Virtual")).toBeNull()
    expect(screen.getByText("@Alice")).toBeInTheDocument()
    expect(screen.getByText("Frontend specialist")).toBeInTheDocument()
  })

  it("applies highlight class when highlighted is true", () => {
    renderRow(virtualCodex, true)
    const row = screen.getByTestId("agent-mention-row-__virtual_codex__")
    expect(row.className).toMatch(/bg-accent/)
  })
})

describe("filterMentionables", () => {
  const all: MentionTarget[] = [virtualClaude, virtualCodex, teammateAlice]

  it("returns all entries on empty query", () => {
    expect(filterMentionables(all, "")).toEqual(all)
  })

  it("matches by case-insensitive name prefix first", () => {
    const out = filterMentionables(all, "co")
    expect(out[0]).toBe(virtualCodex)
  })

  it("falls through to substring match", () => {
    const out = filterMentionables(all, "cli") // matches "Codex CLI" desc
    expect(out.some((t) => t.id === virtualCodex.id)).toBe(true)
  })

  it("returns empty when nothing matches", () => {
    expect(filterMentionables(all, "zzzz")).toEqual([])
  })

  it("matches a gapped subsequence (fuzzy)", () => {
    // "cdx" is a subsequence of "codex" but not a substring — the old
    // substring matcher would have missed it; the shared fuzzy scorer hits it.
    const out = filterMentionables(all, "cdx")
    expect(out.some((t) => t.id === virtualCodex.id)).toBe(true)
  })
})

describe("SubagentMentionRow", () => {
  const reviewer: SubagentMentionTarget = {
    id: "template:my-reviewer",
    name: "My Reviewer",
    description: "Reviews code",
    model: "opus",
    handle: "my-reviewer",
  }
  const noModel: SubagentMentionTarget = {
    id: "workflow-designer",
    name: "Workflow Designer",
    description: "",
    handle: "workflow-designer",
  }

  it("renders @handle, the model badge, and the description", () => {
    render(<SubagentMentionRow target={reviewer} />)
    expect(screen.getByTestId("subagent-mention-row-template:my-reviewer")).toBeInTheDocument()
    expect(screen.getByText("@my-reviewer")).toBeInTheDocument()
    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.getByText("Reviews code")).toBeInTheDocument()
  })

  it("omits the model badge and description when absent", () => {
    render(<SubagentMentionRow target={noModel} />)
    expect(screen.getByText("@workflow-designer")).toBeInTheDocument()
    expect(screen.queryByText("opus")).toBeNull()
  })

  it("applies the highlight class when highlighted", () => {
    render(<SubagentMentionRow target={reviewer} highlighted />)
    expect(screen.getByTestId("subagent-mention-row-template:my-reviewer").className).toMatch(
      /bg-accent/
    )
  })
})

describe("filterSubagents", () => {
  const all: SubagentMentionTarget[] = [
    {
      id: "workflow-designer",
      name: "Workflow Designer",
      description: "Designs flows",
      handle: "workflow-designer",
    },
    {
      id: "template:my-reviewer",
      name: "My Reviewer",
      description: "Reviews code",
      handle: "my-reviewer",
    },
  ]

  it("returns all entries on empty query", () => {
    expect(filterSubagents(all, "")).toEqual(all)
  })

  it("matches by the @handle (primary)", () => {
    const out = filterSubagents(all, "rev")
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("template:my-reviewer")
  })

  it("falls through to the description (secondary)", () => {
    const out = filterSubagents(all, "designs")
    expect(out.some((t) => t.id === "workflow-designer")).toBe(true)
  })

  it("returns empty when nothing matches", () => {
    expect(filterSubagents(all, "zzzz")).toEqual([])
  })
})
