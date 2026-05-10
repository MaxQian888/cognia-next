// Tests for MessageRenderer: rendering logic, bookmark behavior, edit flow,
// file part handling, and memo comparator (via store interactions).

import * as ReactForMocks from "react"

jest.mock("@/components/ai-elements/message", () => ({
  Message: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", { "data-test": "message" }, children),
  MessageContent: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", { "data-test": "message-content" }, children),
  MessageActions: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", { "data-test": "message-actions" }, children),
  MessageAction: ({
    children,
    onClick,
    tooltip,
    disabled,
  }: {
    children: ReactForMocks.ReactNode
    onClick?: () => void
    tooltip?: string
    disabled?: boolean
  }) =>
    ReactForMocks.createElement("button", { onClick, "aria-label": tooltip, disabled }, children),
  MessageResponse: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("span", { "data-test": "message-response" }, children),
}))

jest.mock("@/components/ai-elements/reasoning", () => ({
  Reasoning: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", { "data-test": "reasoning" }, children),
  ReasoningTrigger: () => null,
  ReasoningContent: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", null, children),
}))

jest.mock("@/components/ai-elements/task", () => ({
  Task: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", { "data-test": "task" }, children),
  TaskContent: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", null, children),
  TaskItem: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", null, children),
  TaskTrigger: () => null,
}))

jest.mock("@/components/ai-elements/tool", () => ({
  Tool: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", { "data-test": "tool" }, children),
  ToolBody: () => null,
  ToolHeader: () => null,
  ToolContent: ({ children }: { children: ReactForMocks.ReactNode }) =>
    ReactForMocks.createElement("div", null, children),
}))

jest.mock("./markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) =>
    ReactForMocks.createElement("div", { "data-test": "markdown" }, content),
}))

jest.mock("@/components/chat/message-parts/a2ui-part", () => ({
  A2UIPart: () => ReactForMocks.createElement("div", { "data-test": "a2ui-part" }),
}))

jest.mock("@/components/chat/message-parts/subagent-part", () => ({
  SubagentPart: () => ReactForMocks.createElement("div", { "data-test": "subagent-part" }),
}))

jest.mock("@/components/chat/message-parts/agent-team-dispatch-part", () => ({
  AgentTeamDispatchPart: () => ReactForMocks.createElement("div", { "data-test": "dispatch-part" }),
}))

jest.mock("next-intl", () => {
  const t = (k: string) => k
  return { useTranslations: () => t }
})

jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, copy: jest.fn(async () => true) }),
}))

jest.mock("@/lib/ui/avatar", () => ({
  avatarColor: () => "#aaa",
  avatarGlyph: () => "A",
}))

jest.mock("@/lib/logger", () => ({
  loggers: {
    chat: { error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  },
}))

import { render, screen, fireEvent } from "@testing-library/react"
import type { UIMessage } from "ai"
import { MessageRenderer } from "./message-renderer"
import { useChatStore } from "@/stores/chat"

// ── helpers ──────────────────────────────────────────────────────────────────

function assistantMsg(id = "m1", text = "Hello"): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] }
}

function userMsg(id = "u1", text = "Hi"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] }
}

beforeEach(() => {
  useChatStore.getState().clear()
})

// ── text rendering ────────────────────────────────────────────────────────────

describe("text parts", () => {
  it("renders completed text via MarkdownRenderer", () => {
    render(<MessageRenderer message={assistantMsg()} />)
    expect(document.querySelector("[data-test='markdown']")).toBeTruthy()
    expect(screen.getByText("Hello")).toBeInTheDocument()
  })

  it("renders streaming text via MessageResponse (not MarkdownRenderer)", () => {
    render(<MessageRenderer message={assistantMsg()} isStreaming />)
    expect(document.querySelector("[data-test='markdown']")).toBeNull()
    expect(document.querySelector("[data-test='message-response']")).toBeTruthy()
    expect(screen.getByText("Hello")).toBeInTheDocument()
  })
})

// ── reasoning parts ───────────────────────────────────────────────────────────

describe("reasoning parts", () => {
  it("renders a reasoning block", () => {
    const msg: UIMessage = {
      id: "r1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "thinking…" }],
    }
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("[data-test='reasoning']")).toBeTruthy()
  })
})

// ── file parts ────────────────────────────────────────────────────────────────

describe("file parts", () => {
  it("renders image file as <img>", () => {
    const msg: UIMessage = {
      id: "f1",
      role: "user",
      parts: [{ type: "file", url: "data:image/png;base64,abc", mediaType: "image/png" }],
    }
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("img")).toBeTruthy()
  })

  it("renders non-image file as a download link", () => {
    const msg: UIMessage = {
      id: "f2",
      role: "user",
      parts: [
        {
          type: "file",
          url: "/uploads/report.pdf",
          mediaType: "application/pdf",
          filename: "report.pdf",
        },
      ],
    }
    render(<MessageRenderer message={msg} />)
    expect(screen.getByText("report.pdf")).toBeInTheDocument()
    const link = document.querySelector("a[download]")
    expect(link).toBeTruthy()
    expect(link?.getAttribute("href")).toBe("/uploads/report.pdf")
  })

  it("omits non-image file when url is missing", () => {
    const msg: UIMessage = {
      id: "f3",
      role: "user",
      parts: [{ type: "file", url: undefined as unknown as string, mediaType: "application/pdf" }],
    }
    const { container } = render(<MessageRenderer message={msg} />)
    // No link and no img rendered
    expect(container.querySelector("a")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
  })
})

// ── custom part types ─────────────────────────────────────────────────────────

describe("custom extension parts", () => {
  it("renders a2ui part", () => {
    const msg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "a2ui" } as unknown as UIMessage["parts"][number]],
    }
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("[data-test='a2ui-part']")).toBeTruthy()
  })

  it("renders subagent part", () => {
    const msg: UIMessage = {
      id: "s1",
      role: "assistant",
      parts: [{ type: "subagent" } as unknown as UIMessage["parts"][number]],
    }
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("[data-test='subagent-part']")).toBeTruthy()
  })
})

// ── tool parts ────────────────────────────────────────────────────────────────

describe("tool parts", () => {
  it("renders generic tool block", () => {
    const msg: UIMessage = {
      id: "t1",
      role: "assistant",
      parts: [
        {
          type: "tool-SomeTool",
          toolCallId: "call_1",
          toolName: "SomeTool",
          state: "output-available",
          input: {},
          output: "done",
        } as unknown as UIMessage["parts"][number],
      ],
    }
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("[data-test='tool']")).toBeTruthy()
  })

  it("renders TodoWrite as task list when todos are valid", () => {
    const msg: UIMessage = {
      id: "t2",
      role: "assistant",
      parts: [
        {
          type: "tool-TodoWrite",
          toolCallId: "call_2",
          toolName: "TodoWrite",
          state: "output-available",
          input: {
            todos: [
              { content: "Do A", status: "completed" },
              { content: "Do B", status: "in_progress" },
              { content: "Do C", status: "pending" },
            ],
          },
          output: "",
        } as unknown as UIMessage["parts"][number],
      ],
    }
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("[data-test='task']")).toBeTruthy()
    expect(screen.getByText("Do A")).toBeInTheDocument()
  })
})

// ── bookmark behavior ─────────────────────────────────────────────────────────

describe("bookmark", () => {
  it("toggles bookmark when clicked", () => {
    render(<MessageRenderer message={assistantMsg("bm1")} isLastAssistant />)
    expect(useChatStore.getState().bookmarkedIds).not.toContain("bm1")
    // tooltip is "bookmarkTooltip" (not bookmarked) — our mock sets aria-label=tooltip
    fireEvent.click(screen.getByLabelText("bookmarkTooltip"))
    expect(useChatStore.getState().bookmarkedIds).toContain("bm1")
  })

  it("unbookmarks when clicked a second time", () => {
    useChatStore.getState().toggleBookmark("bm2")
    render(<MessageRenderer message={assistantMsg("bm2")} isLastAssistant />)
    // already bookmarked → tooltip is "bookmarkRemoveTooltip"
    fireEvent.click(screen.getByLabelText("bookmarkRemoveTooltip"))
    expect(useChatStore.getState().bookmarkedIds).not.toContain("bm2")
  })

  it("bookmark selector is scoped: unrelated bookmark does not affect this message", () => {
    // Toggle a DIFFERENT message's bookmark
    useChatStore.getState().toggleBookmark("other-id")
    render(<MessageRenderer message={assistantMsg("target-id")} isLastAssistant />)
    // target-id is NOT bookmarked, so its button shows "bookmarkTooltip" (not "bookmarkRemoveTooltip")
    expect(screen.getByLabelText("bookmarkTooltip")).toBeInTheDocument()
    expect(screen.queryByLabelText("bookmarkRemoveTooltip")).toBeNull()
  })
})

// ── edit flow ─────────────────────────────────────────────────────────────────

describe("edit flow", () => {
  it("shows textarea on edit click, submits on button click", () => {
    const onEditResend = jest.fn()
    render(<MessageRenderer message={userMsg("e1", "original text")} onEditResend={onEditResend} />)
    // mock sets aria-label=tooltip; tooltip is "editTooltip"
    fireEvent.click(screen.getByLabelText("editTooltip"))
    const textarea = screen.getByRole("textbox")
    expect(textarea).toBeInTheDocument()

    fireEvent.change(textarea, { target: { value: "edited text" } })
    fireEvent.click(screen.getByText("editingSubmit"))

    expect(onEditResend).toHaveBeenCalledWith("e1", "edited text")
  })

  it("cancels edit on cancel button click", () => {
    render(<MessageRenderer message={userMsg("e2", "original")} onEditResend={jest.fn()} />)
    fireEvent.click(screen.getByLabelText("editTooltip"))
    expect(screen.getByRole("textbox")).toBeInTheDocument()

    fireEvent.click(screen.getByText("editingCancel"))
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("submits edit with Ctrl+Enter keyboard shortcut", () => {
    const onEditResend = jest.fn()
    render(<MessageRenderer message={userMsg("e3", "hello")} onEditResend={onEditResend} />)
    fireEvent.click(screen.getByLabelText("editTooltip"))
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "modified" } })
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })
    expect(onEditResend).toHaveBeenCalledWith("e3", "modified")
  })

  it("cancels edit with Escape key", () => {
    render(<MessageRenderer message={userMsg("e4", "hello")} onEditResend={jest.fn()} />)
    fireEvent.click(screen.getByLabelText("editTooltip"))
    const textarea = screen.getByRole("textbox")
    fireEvent.keyDown(textarea, { key: "Escape" })
    expect(screen.queryByRole("textbox")).toBeNull()
  })
})

// ── speaker display ───────────────────────────────────────────────────────────

describe("team speaker display", () => {
  it("shows speaker name when characterById resolves senderId", () => {
    const characterById = new Map([
      ["char_1", { id: "char_1", name: "Alice", systemPrompt: "" }],
    ]) as unknown as Map<string, import("@/lib/claude/types").Character>
    const msg: UIMessage = {
      id: "sp1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
      metadata: { senderId: "char_1" },
    } as unknown as UIMessage

    render(<MessageRenderer message={msg} characterById={characterById} />)
    expect(screen.getByText("Alice")).toBeInTheDocument()
  })
})

// ── regenerate action ─────────────────────────────────────────────────────────

describe("regenerate action", () => {
  it("shows regenerate button only for last assistant message", () => {
    const onRegenerate = jest.fn()
    render(<MessageRenderer message={assistantMsg()} isLastAssistant onRegenerate={onRegenerate} />)
    // tooltip = "regenerateTooltip" in mock
    expect(screen.getByLabelText("regenerateTooltip")).toBeInTheDocument()
  })

  it("does not show regenerate button when not last assistant", () => {
    render(
      <MessageRenderer message={assistantMsg()} isLastAssistant={false} onRegenerate={jest.fn()} />
    )
    expect(screen.queryByLabelText("regenerateTooltip")).toBeNull()
  })
})
