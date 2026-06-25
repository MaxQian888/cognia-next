/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { UIMessage } from "ai"

import { RunPanel } from "./run-panel"
import { useChatStore, makeSessionSlice, type SessionChatSlice } from "@/stores/chat"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

// Identity i18n with var echo.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Stub the heavy reused renderers — they have their own suites.
jest.mock("./message-parts/tool-call-row", () => ({
  ToolCallRow: ({ part }: { part: { type: string } }) => (
    <div data-testid="tool-row" data-tool={part.type} />
  ),
}))
jest.mock("./message-parts/subagent-tree", () => ({
  SubagentTree: ({ parts }: { parts: unknown[] }) => (
    <div data-testid="subagent-tree" data-count={parts.length} />
  ),
}))

const SID = "s1"

function seed(slice: Partial<SessionChatSlice>) {
  useChatStore.setState({
    activeSessionId: SID,
    sessions: { [SID]: { ...makeSessionSlice(), ...slice } },
  })
}

function assistant(parts: unknown[]): UIMessage {
  return { id: "a1", role: "assistant", parts } as unknown as UIMessage
}

function toolPart(toolCallId: string, name: string, state: string, input: unknown = {}) {
  return { type: `tool-${name}`, state, input, toolCallId }
}

function todoPart(todos: unknown[]) {
  return { type: "tool-TodoWrite", state: "output-available", input: { todos }, toolCallId: "td" }
}

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: {} })
  useSubagentRuntimeStore.setState({ subAgents: {} })
})

describe("RunPanel — expansion", () => {
  it("shows an expand toggle only when the turn has work", () => {
    seed({ status: "streaming", messages: [] })
    const { rerender } = render(<RunPanel sessionId={SID} />)
    expect(screen.queryByTestId("run-panel-toggle")).not.toBeInTheDocument()

    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Bash", "input-available")])],
    })
    rerender(<RunPanel sessionId={SID} key="2" />)
    expect(screen.getByTestId("run-panel-toggle")).toBeInTheDocument()
  })

  it("reveals the Tools section with a row per tool when expanded", () => {
    seed({
      status: "streaming",
      messages: [
        assistant([
          toolPart("t1", "Read", "output-available", { file_path: "/a" }),
          toolPart("t2", "Bash", "input-available", { command: "ls" }),
        ]),
      ],
    })
    render(<RunPanel sessionId={SID} />)
    expect(screen.queryByTestId("run-panel-body")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByTestId("run-panel-body")).toBeInTheDocument()
    expect(screen.getAllByTestId("tool-row")).toHaveLength(2)
  })

  it("renders per-tool elapsed from the timestamp map", () => {
    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Read", "output-available", { file_path: "/a" })])],
      toolTimestamps: { t1: { startedAt: 1000, endedAt: 4000 } },
    })
    render(<RunPanel sessionId={SID} />)
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByText("3s")).toBeInTheDocument()
  })

  it("renders the Plan section from a TodoWrite snapshot", () => {
    seed({
      status: "streaming",
      messages: [assistant([todoPart([{ content: "do the thing", status: "pending" }])])],
    })
    render(<RunPanel sessionId={SID} />)
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByText("do the thing")).toBeInTheDocument()
  })

  it("renders the Sub-agents section from subagent parts", () => {
    const sub = {
      type: "subagent",
      subagentId: "sa1",
      parentSessionId: SID,
      name: "reviewer",
      status: "running",
      progress: 0,
      startedAt: 1,
    }
    seed({ status: "streaming", messages: [assistant([sub])] })
    render(<RunPanel sessionId={SID} />)
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByTestId("subagent-tree")).toBeInTheDocument()
  })
})

describe("RunPanel — idle replay", () => {
  it("shows a Last-run bar when idle with a settled record", () => {
    seed({
      status: "idle",
      messages: [assistant([toolPart("t1", "Read", "output-available", { file_path: "/a" })])],
    })
    render(<RunPanel sessionId={SID} />)
    expect(screen.getByTestId("run-panel-replay-summary")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByTestId("run-panel-body")).toBeInTheDocument()
  })

  it("renders nothing when idle with no work and no queue", () => {
    seed({ status: "idle", messages: [] })
    const { container } = render(<RunPanel sessionId={SID} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("RunPanel — accessibility", () => {
  it("sets aria-atomic false and labels the interrupt + toggle controls", () => {
    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Bash", "input-available")])],
    })
    render(<RunPanel sessionId={SID} />)
    expect(screen.getByTestId("run-status-bar")).toHaveAttribute("aria-atomic", "false")
    expect(screen.getByLabelText("ariaInterrupt")).toBeInTheDocument()
    const toggle = screen.getByTestId("run-panel-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
  })
})
