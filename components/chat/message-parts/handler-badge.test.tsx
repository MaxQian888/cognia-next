/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { HandlerBadge, pickMostRecentTracked } from "./handler-badge"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

beforeEach(() => {
  useSubagentRuntimeStore.getState().clearRuntime()
})

describe("pickMostRecentTracked", () => {
  it("returns null when no tracked name appears in the registry", () => {
    expect(
      pickMostRecentTracked({ a: { name: "some-other-agent", lastActivityAt: 100 } }, [
        "workflow-designer",
      ])
    ).toBeNull()
  })

  it("picks the most-recently-active tracked subagent", () => {
    const result = pickMostRecentTracked(
      {
        a: { name: "workflow-designer", lastActivityAt: 100 },
        b: { name: "workflow-debugger", lastActivityAt: 200 },
        c: { name: "workflow-refactorer", lastActivityAt: 50 },
      },
      ["workflow-designer", "workflow-debugger", "workflow-refactorer"]
    )
    expect(result).toBe("workflow-debugger")
  })

  it("ignores untracked names even if more recent", () => {
    const result = pickMostRecentTracked(
      {
        a: { name: "workflow-designer", lastActivityAt: 100 },
        b: { name: "intruder", lastActivityAt: 999 },
      },
      ["workflow-designer"]
    )
    expect(result).toBe("workflow-designer")
  })

  it("handles ISO string timestamps", () => {
    const result = pickMostRecentTracked(
      {
        a: { name: "workflow-designer", lastActivityAt: "2026-01-01T00:00:00.000Z" },
        b: { name: "workflow-debugger", lastActivityAt: "2026-02-01T00:00:00.000Z" },
      },
      ["workflow-designer", "workflow-debugger"]
    )
    expect(result).toBe("workflow-debugger")
  })
})

describe("HandlerBadge", () => {
  it("shows the defaultLabel when no tracked subagent is active", () => {
    render(<HandlerBadge defaultLabel="Copilot" />)
    expect(screen.getByTestId("handler-badge")).toHaveTextContent(/copilot/i)
    expect(screen.getByTestId("handler-badge").getAttribute("data-handover")).toBe("false")
  })

  it("switches to a tracked subagent name when one becomes active", () => {
    useSubagentRuntimeStore.getState().upsert({
      id: "sa1",
      parentAgentId: "p",
      name: "workflow-debugger",
      description: "",
      task: "",
      initialTask: "",
      threadId: "t",
      status: "running",
      config: {} as never,
      messages: [],
      sources: [],
      logs: [],
      progress: 50,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      retryCount: 0,
      order: 0,
    } as never)
    render(<HandlerBadge defaultLabel="Copilot" />)
    expect(screen.getByTestId("handler-badge")).toHaveTextContent(/workflow-debugger/)
    expect(screen.getByTestId("handler-badge").getAttribute("data-handover")).toBe("true")
  })
})
