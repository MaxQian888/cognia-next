/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { SpawnTaskCard } from "./spawn-task-card"

const revealSpawnedTask = jest.fn()
let sessionRow: { lastMessageAt?: number } | undefined = {}

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => sessionRow }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ sessions: { get: jest.fn() } }) }))
jest.mock("@/lib/tasks/spawn-task-dispatch", () => ({
  revealSpawnedTask: (...args: unknown[]) => revealSpawnedTask(...args),
}))

const output = {
  ok: true,
  taskSessionId: "task-1",
  title: "Fix retry cleanup",
  tldr: "Handle cleanup as a focused task.",
  situation: "The abort controller survives completion.",
  codeLocations: ["hooks/chat/use-stream.ts:42"],
  solution: "Clear it on the terminal event.",
  caveats: ["Preserve retries."],
  mode: "aside",
}

function part(value: unknown = output): ToolUIPart {
  return {
    type: "tool-spawn_task",
    toolCallId: "call-1",
    state: "output-available",
    input: {},
    output: value,
  } as unknown as ToolUIPart
}

describe("SpawnTaskCard", () => {
  beforeEach(() => {
    revealSpawnedTask.mockClear()
    sessionRow = {}
  })

  it("renders the scoped brief and starts the task in its sidechat", () => {
    render(<SpawnTaskCard part={part()} sessionId="parent-1" />)
    expect(screen.getByText("Fix retry cleanup")).toBeInTheDocument()
    expect(screen.getByText("Handle cleanup as a focused task.")).toBeInTheDocument()
    expect(screen.getByText("aside")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "start" }))
    expect(revealSpawnedTask).toHaveBeenCalledWith("parent-1", "task-1")
  })

  it("switches to Open after the task has messages and exposes collapsible details", () => {
    sessionRow = { lastMessageAt: 123 }
    render(<SpawnTaskCard part={part()} sessionId="parent-1" />)
    expect(screen.getByRole("button", { name: "open" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "situation" }))
    expect(screen.getByText("The abort controller survives completion.")).toBeInTheDocument()
  })

  it("returns null for a failed or malformed result", () => {
    const { container, rerender } = render(<SpawnTaskCard part={part({ ok: false })} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<SpawnTaskCard part={part({ ok: true, taskSessionId: "task-1" })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders an inherited brief without optional detail sections", () => {
    render(
      <SpawnTaskCard
        part={part({
          ...output,
          mode: "inherit",
          situation: "",
          codeLocations: [],
          solution: "",
          caveats: [],
        })}
        sessionId="parent-1"
      />
    )

    expect(screen.getByText("inherit")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "situation" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "solution" })).not.toBeInTheDocument()
  })
})
