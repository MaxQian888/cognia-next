// Tests for MessageRenderer: rendering logic, bookmark behavior, edit flow,
// file part handling, and memo comparator (via store interactions).

import * as ReactForMocks from "react"

jest.mock("@/components/ai-elements/message", () => ({
  Message: ({
    children,
    className,
    from,
  }: {
    children: ReactForMocks.ReactNode
    className?: string
    from?: string
  }) =>
    ReactForMocks.createElement(
      "div",
      { "data-test": "message", "data-from": from, className },
      children
    ),
  MessageContent: ({
    children,
    className,
  }: {
    children: ReactForMocks.ReactNode
    className?: string
  }) => ReactForMocks.createElement("div", { "data-test": "message-content", className }, children),
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
  ToolInput: ({ input }: { input: unknown }) =>
    ReactForMocks.createElement("div", { "data-test": "tool-input" }, JSON.stringify(input)),
}))

jest.mock("@/components/ai-elements/error-trace", () => ({
  ErrorTraceDetails: ({
    error,
    title,
    body,
  }: {
    error: { message: string } | null
    title?: string
    body?: ReactForMocks.ReactNode
  }) =>
    ReactForMocks.createElement(
      "div",
      { "data-test": "error-trace", "data-title": title, "data-has-body": body ? "true" : "false" },
      error?.message ?? ""
    ),
}))

jest.mock("./markdown-renderer", () => ({
  MarkdownRenderer: ({ content, projectRoot }: { content: string; projectRoot?: string }) =>
    ReactForMocks.createElement(
      "div",
      { "data-test": "markdown", "data-project-root": projectRoot },
      content
    ),
}))

jest.mock("@/components/chat/renderers/message-image-gallery", () => ({
  MessageImageGallery: ({ items }: { items: Array<{ src: string }> }) =>
    ReactForMocks.createElement("div", {
      "data-testid": "message-image-gallery",
      "data-count": items.length,
    }),
}))

jest.mock("@/components/chat/message-parts/attachment-text-card", () => ({
  AttachmentTextCard: ({ filename, text }: { filename: string; text: string }) =>
    ReactForMocks.createElement(
      "div",
      { "data-testid": "attachment-text-card" },
      `${filename}:${text}`
    ),
}))

jest.mock("@/components/chat/memory-chips", () => ({
  MemoryLearnedChip: ({ messageId }: { messageId: string }) =>
    ReactForMocks.createElement("div", { "data-testid": "memory-learned-chip" }, messageId),
  MemoryRecalledChip: () =>
    ReactForMocks.createElement("div", { "data-testid": "memory-recalled-chip" }),
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

jest.mock("@/components/chat/message-parts/artifact-part", () => ({
  ArtifactPart: () => ReactForMocks.createElement("div", { "data-test": "artifact-part" }),
}))

jest.mock("@/components/chat/message-parts/sources-part", () => ({
  SourcesPart: () => ReactForMocks.createElement("div", { "data-test": "sources-part" }),
}))

jest.mock("@/components/chat/message-parts/terminal-tool-part", () => ({
  TerminalToolPart: () => ReactForMocks.createElement("div", { "data-test": "terminal-tool-part" }),
}))

jest.mock("@/components/chat/branch-navigator", () => ({
  BranchNavigator: () => null,
}))

jest.mock("@/components/chat/branch-dialog", () => ({
  BranchDialog: ({ open, messageId }: { open: boolean; messageId: string }) =>
    open
      ? ReactForMocks.createElement("div", {
          "data-testid": "branch-dialog",
          "data-msg": messageId,
        })
      : null,
}))

jest.mock("next-intl", () => {
  const t = (k: string) => k
  return { useTranslations: () => t }
})

// Read-aloud gating: control ttsEnabled via the settings selector, and stub
// the button so we only assert it mounts (its own behavior is covered by
// read-aloud-button.test.tsx).
const settingsState = { settings: { ttsEnabled: false } as { ttsEnabled: boolean } }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))
jest.mock("./read-aloud-button", () => ({
  ReadAloudButton: ({ messageId }: { messageId: string }) =>
    ReactForMocks.createElement("div", { "data-testid": "read-aloud", "data-msg": messageId }),
}))

jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, copy: jest.fn(async () => true) }),
}))

jest.mock("@/lib/ui/avatar", () => ({
  avatarColor: () => "#aaa",
  avatarGlyph: () => "A",
}))

jest.mock("@cognia/logging", () => {
  const childLogger = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: function () {
      return this
    },
    withContext: function () {
      return this
    },
  }
  // The transitive import graph (artifact-store → lib/plugin → many *-api
  // modules) reads `loggers.<namespace>.child(...)` at module-eval time for a
  // wide set of namespaces. A Proxy hands every namespace the same stub logger.
  const loggers = new Proxy({}, { get: () => childLogger })
  return { loggers, createLogger: () => childLogger }
})

// Agent-flow display mode + grouping (covered in depth by their own suites;
// here we only assert MessageRenderer's dispatch wiring).
let mockFlowMode = "standard"
jest.mock("@/hooks/chat/use-agent-flow-mode", () => ({
  useAgentFlowMode: () => ({ mode: mockFlowMode, setMode: jest.fn() }),
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  MotionReveal: ({ children }: { children: ReactForMocks.ReactNode }) => children,
  MotionCollapse: ({ children }: { children: ReactForMocks.ReactNode }) => children,
  MotionStatusSwap: ({ children }: { children: ReactForMocks.ReactNode }) => children,
  useFlowMotion: () => ({ reduce: true }),
}))
// Stands in for the real group's chrome but keeps its contract: every child is
// rendered through the caller's `renderChild`, in both open-state styles. That
// is what makes a grouped tool go through `renderToolPart` (and pick up its
// per-call plugin action slot) exactly like a standalone one.
jest.mock("@/components/chat/message-parts/tool-activity-group", () => ({
  ToolActivityGroup: ({
    entries,
    mode,
    renderChild,
  }: {
    entries: Array<{ part: { type: string }; key: string }>
    mode: string
    renderChild: (
      part: { type: string },
      key: string,
      opts: { forceOpen?: boolean; expanded?: boolean; onToggle?: () => void }
    ) => ReactForMocks.ReactNode
  }) =>
    ReactForMocks.createElement(
      "div",
      {
        "data-test": "activity-group",
        "data-mode": mode,
        "data-count": entries.length,
      },
      entries.map((e) =>
        renderChild(
          e.part,
          e.key,
          mode === "simplified"
            ? { expanded: false, onToggle: () => {} }
            : { forceOpen: mode === "detailed" ? true : undefined }
        )
      )
    ),
}))
jest.mock("@/components/chat/message-parts/tool-call-row", () => ({
  ToolCallRow: ({ part }: { part: { type: string } }) =>
    ReactForMocks.createElement("div", { "data-test": "tool-call-row", "data-type": part.type }),
}))

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"
import { MessageRenderer } from "./message-renderer"
import { TooltipProvider } from "@/components/ui/tooltip"
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

  it("passes the conversation project root to completed Markdown", () => {
    render(<MessageRenderer message={assistantMsg()} projectRoot="/repo" />)
    expect(document.querySelector("[data-test='markdown']")).toHaveAttribute(
      "data-project-root",
      "/repo"
    )
  })

  it("renders streaming text via MessageResponse (not MarkdownRenderer)", () => {
    render(<MessageRenderer message={assistantMsg()} isStreaming />)
    expect(document.querySelector("[data-test='markdown']")).toBeNull()
    expect(document.querySelector("[data-test='message-response']")).toBeTruthy()
    expect(screen.getByText("Hello")).toBeInTheDocument()
  })
})

// ── usage breakdown ───────────────────────────────────────────────────────────

describe("usage breakdown", () => {
  function withUsage(usage: Record<string, number>): UIMessage {
    return { ...assistantMsg(), metadata: { usage } } as unknown as UIMessage
  }

  it("shows a reasoning line only when reasoning tokens were reported", () => {
    // Radix tooltip content mounts on open; focus opens it without delay.
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <MessageRenderer
          message={withUsage({ inputTokens: 10, outputTokens: 40, reasoningTokens: 32 })}
        />
      </TooltipProvider>
    )
    fireEvent.focus(screen.getByText(/↑10 ↓40/))
    // translation mock returns the key verbatim → the line renders "usageReasoning".
    expect(screen.getAllByText("usageReasoning").length).toBeGreaterThan(0)

    // No reasoning tokens → no reasoning line.
    rerender(
      <TooltipProvider delayDuration={0}>
        <MessageRenderer message={withUsage({ inputTokens: 10, outputTokens: 20 })} />
      </TooltipProvider>
    )
    fireEvent.focus(screen.getByText(/↑10 ↓20/))
    expect(screen.queryByText("usageReasoning")).toBeNull()
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

describe("commentary parts", () => {
  it("renders commentary as progress without using the reasoning disclosure", () => {
    const msg = {
      id: "c1",
      role: "assistant",
      parts: [
        {
          type: "data-commentary",
          data: { text: "Checking the affected files", state: "streaming", source: "codex" },
        },
      ],
    } as unknown as UIMessage

    render(<MessageRenderer message={msg} isStreaming />)

    expect(screen.getByRole("status")).toHaveTextContent("Checking the affected files")
    expect(document.querySelector("[data-test='reasoning']")).toBeNull()
  })
})

describe("memory transparency chips", () => {
  it("mounts learned and recalled chips for a completed assistant turn", () => {
    const msg = {
      id: "memory-1",
      role: "assistant",
      parts: [
        { type: "text", text: "answer" },
        { type: "sources", sources: [{ type: "memory", id: "m1" }] },
      ],
    } as unknown as UIMessage

    render(<MessageRenderer message={msg} isStreaming={false} />)

    expect(screen.getByTestId("memory-learned-chip")).toHaveTextContent("memory-1")
    expect(screen.getByTestId("memory-recalled-chip")).toBeInTheDocument()
  })

  it("does not mount memory chips while the assistant is streaming", () => {
    render(<MessageRenderer message={assistantMsg("memory-stream", "answer")} isStreaming />)
    expect(screen.queryByTestId("memory-learned-chip")).not.toBeInTheDocument()
    expect(screen.queryByTestId("memory-recalled-chip")).not.toBeInTheDocument()
  })
})

// ── file parts ────────────────────────────────────────────────────────────────

describe("file parts", () => {
  it("renders image files through the thumbnail gallery", () => {
    const msg: UIMessage = {
      id: "f1",
      role: "user",
      parts: [{ type: "file", url: "data:image/png;base64,abc", mediaType: "image/png" }],
    }
    render(<MessageRenderer message={msg} />)
    expect(screen.getByTestId("message-image-gallery")).toHaveAttribute("data-count", "1")
  })

  it("groups every image file into one gallery while preserving non-image files", () => {
    const msg: UIMessage = {
      id: "f-gallery",
      role: "user",
      parts: [
        {
          type: "file",
          url: "data:image/png;base64,one",
          mediaType: "image/png",
          filename: "one.png",
        },
        {
          type: "file",
          url: "/uploads/archive.bin",
          mediaType: "application/octet-stream",
          filename: "archive.bin",
        },
        {
          type: "file",
          url: "data:image/png;base64,two",
          mediaType: "image/png",
          filename: "two.png",
        },
      ],
    }
    render(<MessageRenderer message={msg} />)

    expect(screen.getAllByTestId("message-image-gallery")).toHaveLength(1)
    expect(screen.getByTestId("message-image-gallery")).toHaveAttribute("data-count", "2")
    expect(screen.getByText("archive.bin")).toBeInTheDocument()
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

  it("renders an attached document's extracted text as a collapsed file card", () => {
    const msg = {
      id: "f-text",
      role: "user",
      parts: [
        {
          type: "file",
          mediaType: "text/plain",
          filename: "report.txt",
          text: "extracted payload",
        },
      ],
    } as unknown as UIMessage
    render(<MessageRenderer message={msg} />)
    expect(screen.getByTestId("attachment-text-card")).toHaveTextContent(
      "report.txt:extracted payload"
    )
  })

  it("copies an image-only message as rich clipboard content", async () => {
    const write = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText: jest.fn() },
    })
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: class {
        constructor(readonly entries: Record<string, Blob>) {}
      },
    })
    const msg: UIMessage = {
      id: "copy-images",
      role: "user",
      parts: [
        { type: "file", url: "data:image/png;base64,YQ==", mediaType: "image/png" },
        { type: "file", url: "data:image/png;base64,Yg==", mediaType: "image/png" },
      ],
    }

    render(<MessageRenderer message={msg} />)
    fireEvent.click(screen.getByLabelText("copyTooltip"))

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    const item = write.mock.calls[0][0][0] as { entries: Record<string, Blob> }
    expect(Object.keys(item.entries)).toEqual(["text/plain", "text/html"])
  })

  it("shares every inline image as a native file", async () => {
    const share = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "share", { configurable: true, value: share })
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: ({ files }: ShareData) => Boolean(files?.length),
    })
    const msg: UIMessage = {
      id: "share-images",
      role: "user",
      parts: [
        { type: "text", text: "Two images" },
        {
          type: "file",
          url: "data:image/png;base64,YQ==",
          mediaType: "image/png",
          filename: "one.png",
        },
        {
          type: "file",
          url: "data:image/png;base64,Yg==",
          mediaType: "image/png",
          filename: "two.png",
        },
        {
          type: "source-url",
          sourceId: "source-1",
          url: "https://example.com/source",
          title: "Source",
        },
      ],
    }

    render(<MessageRenderer message={msg} />)
    fireEvent.click(screen.getByLabelText("shareTooltip"))

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    expect(share.mock.calls[0][0]).toMatchObject({
      text: "Two images\n\none.png\n\ntwo.png\n\n[Source](https://example.com/source)",
    })
    expect(share.mock.calls[0][0].files).toHaveLength(2)
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

  it("renders subagent parts as a dispatch tree", () => {
    const msg: UIMessage = {
      id: "s1",
      role: "assistant",
      parts: [{ type: "subagent", subagentId: "x" } as unknown as UIMessage["parts"][number]],
    }
    render(<MessageRenderer message={msg} />)
    // The subagent part is collected into the SubagentTree, which renders the
    // (mocked) SubagentPart card for each node.
    expect(document.querySelector("[data-test='subagent-part']")).toBeTruthy()
  })

  it("renders an inline hook-notice part (external agent)", () => {
    const msg: UIMessage = {
      id: "h1",
      role: "assistant",
      parts: [
        {
          type: "hook-notice",
          event: "PreToolUse",
          toolName: "Bash",
          outcome: "blocked",
          block: "command matches denylist",
          warnings: [],
        } as unknown as UIMessage["parts"][number],
      ],
    }
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("[data-testid='hook-notice-blocked']")).toBeTruthy()
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

  it("renders a dynamic-tool part as a tool call, not an unknown part", () => {
    // `dynamic-tool` is the AI SDK shape for a tool the client never declared
    // statically — imported transcripts and CLI handoff carry it.
    const msg: UIMessage = {
      id: "dt1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "SomeTool",
          toolCallId: "call_d",
          state: "output-available",
          input: {},
          output: "done",
        } as unknown as UIMessage["parts"][number],
      ],
    }
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("[data-test='tool']")).toBeTruthy()
    expect(document.querySelector("[data-testid='unknown-part-card']")).toBeNull()
  })

  it("renders ErrorTraceDetails when the tool part is in output-error state", () => {
    const msg: UIMessage = {
      id: "terr",
      role: "assistant",
      parts: [
        {
          type: "tool-Bash",
          toolCallId: "call_e",
          toolName: "Bash",
          state: "output-error",
          input: { command: "exit 1" },
          errorText: "Command failed with exit code 1",
        } as unknown as UIMessage["parts"][number],
      ],
    }
    render(<MessageRenderer message={msg} />)
    const trace = document.querySelector("[data-test='error-trace']")
    expect(trace).toBeTruthy()
    expect(trace?.textContent).toBe("Command failed with exit code 1")
    expect(trace?.getAttribute("data-title")).toBe("toolCallFailed")
    // The structured parsed body is wired into the alert.
    expect(trace?.getAttribute("data-has-body")).toBe("true")
    // The input section is preserved so users still see the failing call.
    expect(document.querySelector("[data-test='tool-input']")).toBeTruthy()
  })

  it("falls back to a generic message when errorText is missing", () => {
    const msg: UIMessage = {
      id: "terr2",
      role: "assistant",
      parts: [
        {
          type: "tool-Edit",
          toolCallId: "call_e2",
          toolName: "Edit",
          state: "output-error",
          input: { path: "a.ts" },
        } as unknown as UIMessage["parts"][number],
      ],
    }
    render(<MessageRenderer message={msg} />)
    const trace = document.querySelector("[data-test='error-trace']")
    expect(trace?.textContent).toBe("toolCallFailed")
  })

  it("routes the core bash tool (flat and namespaced) to the terminal renderer", () => {
    for (const type of ["tool-bash", "tool-mcp__cognia-tools__bash"]) {
      const { unmount } = render(
        <MessageRenderer
          message={{
            id: `b-${type}`,
            role: "assistant",
            parts: [
              {
                type,
                toolCallId: "call_b",
                state: "output-available",
                input: { command: "ls" },
                output: "src",
              } as unknown as UIMessage["parts"][number],
            ],
          }}
        />
      )
      expect(document.querySelector("[data-test='terminal-tool-part']")).toBeTruthy()
      unmount()
    }
  })

  it("renders the namespaced core TodoWrite as the task list", () => {
    const msg: UIMessage = {
      id: "t-ns",
      role: "assistant",
      parts: [
        {
          type: "tool-mcp__cognia-tools__TodoWrite",
          toolCallId: "call_ns",
          state: "output-available",
          input: { todos: [{ content: "Core task", status: "in_progress" }] },
          output: "",
        } as unknown as UIMessage["parts"][number],
      ],
    }
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("[data-test='task']")).toBeTruthy()
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

// ── plugin part renderer fallback ─────────────────────────────────────────────

describe("plugin message-part renderer", () => {
  const { registerMessagePartRenderer, clearAllMessagePartRenderers } =
    require("@/lib/plugin/api/message-part-renderers") as typeof import("@/lib/plugin/api/message-part-renderers")

  beforeEach(() => {
    clearAllMessagePartRenderers()
  })

  it("delegates an unknown part type to the registered plugin renderer", () => {
    registerMessagePartRenderer(
      "weather-plugin",
      "weather",
      ({ part }: { part: { type: string; city?: string } }) =>
        ReactForMocks.createElement("div", { "data-test": "weather-card" }, part.city ?? "no-city")
    )
    const msg: UIMessage = {
      id: "p1",
      role: "assistant",
      parts: [
        {
          type: "weather",
          city: "Beijing",
        } as unknown as UIMessage["parts"][number],
      ],
    }
    render(<MessageRenderer message={msg} />)
    const card = document.querySelector("[data-test='weather-card']")
    expect(card).toBeTruthy()
    expect(card?.textContent).toBe("Beijing")
  })

  it("renders an error placeholder when the plugin renderer throws", () => {
    const Boom = () => {
      throw new Error("plugin crashed")
    }
    registerMessagePartRenderer("bad-plugin", "broken", Boom)
    const msg: UIMessage = {
      id: "p2",
      role: "assistant",
      parts: [{ type: "broken" } as unknown as UIMessage["parts"][number]],
    }
    // Silence the boundary's console output.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    render(<MessageRenderer message={msg} />)
    const errNode = screen.getByRole("alert")
    expect(errNode).toHaveAttribute("data-plugin-surface-error", "true")
    expect(screen.getByText("retry")).toBeInTheDocument()
    errSpy.mockRestore()
  })

  it("does NOT delegate `tool-` types or host-owned parts to plugins", () => {
    const HostStub = ({ part }: { part: { type: string } }) =>
      ReactForMocks.createElement("div", { "data-test": "host-stub" }, part.type)
    registerMessagePartRenderer("malicious-plugin", "tool-Bash", HostStub)
    // The reserved-prefix gate runs in the plugin API; here we exercise the
    // renderer-side gate directly by registering then asserting the host
    // path takes over instead.
    const msg: UIMessage = {
      id: "p3",
      role: "assistant",
      parts: [
        {
          type: "tool-Bash",
          state: "output-available",
          input: {},
          output: "ok",
        } as unknown as UIMessage["parts"][number],
      ],
    }
    render(<MessageRenderer message={msg} />)
    // The host renders tool-Bash via the Terminal-tool component (mocked in
    // this file as the generic `tool` wrapper). The plugin renderer must
    // NOT be selected.
    expect(document.querySelector("[data-test='host-stub']")).toBeNull()
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

// ── branch action ──────────────────────────────────────────────────────────────

describe("branch action", () => {
  it("opens the branch dialog when an active session is set", () => {
    useChatStore.setState({ activeSessionId: "sess-1" })
    render(<MessageRenderer message={assistantMsg("br1")} />)
    expect(screen.queryByTestId("branch-dialog")).toBeNull()
    fireEvent.click(screen.getByLabelText("branchTooltip"))
    expect(screen.getByTestId("branch-dialog")).toHaveAttribute("data-msg", "br1")
  })

  it("hides the branch action when there is no session id", () => {
    useChatStore.setState({ activeSessionId: null })
    render(<MessageRenderer message={assistantMsg("br2")} />)
    expect(screen.queryByLabelText("branchTooltip")).toBeNull()
  })

  it("disables the branch action mid-turn so it cannot copy a half-written reply", () => {
    // A branch snapshots the visible thread; taking one while the reply is still
    // streaming would clone a truncated message and seed the child from an
    // unfinished exchange. Matches the regenerate action's existing guard.
    useChatStore.setState({ activeSessionId: "sess-1" })
    render(<MessageRenderer message={assistantMsg("br3")} isStreaming />)
    // The tooltip swaps to explain WHY it is unavailable rather than just
    // greying out with no reason.
    const action = screen.getByLabelText("branchStreamingTooltip")
    expect(action).toBeDisabled()
    fireEvent.click(action)
    expect(screen.queryByTestId("branch-dialog")).toBeNull()
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
    ]) as unknown as Map<string, import("@cognia/agent-config-types").Character>
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

// ── mention highlighting (user messages) ─────────────────────────────────────

describe("mention highlighting", () => {
  it("renders one styled mention chip per known character match", () => {
    const characterById = new Map([
      ["char_alice", { id: "char_alice", name: "Alice", systemPrompt: "" }],
      ["char_bob", { id: "char_bob", name: "Bob", systemPrompt: "" }],
    ]) as unknown as Map<string, import("@cognia/agent-config-types").Character>

    const msg: UIMessage = {
      id: "u-mentions",
      role: "user",
      parts: [{ type: "text", text: "hey @Alice and @Bob, look here" }],
    }

    const { container } = render(<MessageRenderer message={msg} characterById={characterById} />)

    const chips = container.querySelectorAll("span.rounded.bg-muted")
    expect(chips.length).toBe(2)
    expect(chips[0].textContent).toBe("@Alice")
    expect(chips[1].textContent).toBe("@Bob")
  })

  it("preserves mention chips when the same message re-renders with identical text", () => {
    const characterById = new Map([
      ["char_alice", { id: "char_alice", name: "Alice", systemPrompt: "" }],
    ]) as unknown as Map<string, import("@cognia/agent-config-types").Character>

    const msg: UIMessage = {
      id: "u-mention-stable",
      role: "user",
      parts: [{ type: "text", text: "ping @Alice" }],
    }

    const { container, rerender } = render(
      <MessageRenderer message={msg} characterById={characterById} />
    )
    const firstChip = container.querySelector("span.rounded.bg-muted")
    expect(firstChip?.textContent).toBe("@Alice")

    rerender(<MessageRenderer message={msg} characterById={characterById} />)
    const secondChip = container.querySelector("span.rounded.bg-muted")
    // React reconciliation reuses the same DOM node when keys are stable.
    expect(secondChip).toBe(firstChip)
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

// ── read-aloud gating ─────────────────────────────────────────────────────────

describe("read-aloud button", () => {
  afterEach(() => {
    settingsState.settings.ttsEnabled = false
  })

  it("mounts the read-aloud button on assistant messages when TTS is enabled", () => {
    settingsState.settings.ttsEnabled = true
    render(<MessageRenderer message={assistantMsg("ra1")} />)
    const el = screen.getByTestId("read-aloud")
    expect(el).toBeInTheDocument()
    expect(el).toHaveAttribute("data-msg", "ra1")
  })

  it("hides the read-aloud button when TTS is disabled", () => {
    settingsState.settings.ttsEnabled = false
    render(<MessageRenderer message={assistantMsg("ra2")} />)
    expect(screen.queryByTestId("read-aloud")).toBeNull()
  })

  it("never shows the read-aloud button on user messages", () => {
    settingsState.settings.ttsEnabled = true
    render(<MessageRenderer message={userMsg("ra3")} />)
    expect(screen.queryByTestId("read-aloud")).toBeNull()
  })
})

describe("agent-flow grouping + mode", () => {
  afterEach(() => {
    mockFlowMode = "standard"
  })

  function toolMsg(id: string, ...types: string[]): UIMessage {
    return {
      id,
      role: "assistant",
      parts: types.map((type) => ({ type, state: "output-available", input: {} })),
    } as unknown as UIMessage
  }

  it("collapses a run of ≥2 consecutive tool calls into an activity group", () => {
    render(<MessageRenderer message={toolMsg("g1", "tool-SomeTool", "tool-OtherTool")} />)
    const group = document.querySelector("[data-test='activity-group']")
    expect(group).toBeTruthy()
    expect(group?.getAttribute("data-count")).toBe("2")
    expect(group?.getAttribute("data-mode")).toBe("standard")
    // The individual cards are owned by the group — rendered through its
    // `renderChild`, never standalone alongside it.
    expect(group?.querySelectorAll("[data-test='tool']")).toHaveLength(2)
    expect(document.querySelectorAll("[data-test='tool']")).toHaveLength(2)
  })

  // Regression: the group used to render its simplified children itself,
  // bypassing `renderToolPart` — so every tool inside a folded run lost the
  // per-call plugin action slot (and the session id its cards need).
  it("routes a grouped run through the shared tool renderer in simplified mode", () => {
    mockFlowMode = "simplified"
    render(<MessageRenderer message={toolMsg("g1s", "tool-Read", "tool-Grep")} />)
    const group = document.querySelector("[data-test='activity-group']")
    expect(group?.getAttribute("data-mode")).toBe("simplified")
    const rows = group?.querySelectorAll("[data-test='tool-call-row']")
    expect(rows).toHaveLength(2)
    expect(rows?.[0].getAttribute("data-type")).toBe("tool-Read")
    // …and no standard card leaked in alongside the rows.
    expect(document.querySelector("[data-test='tool']")).toBeNull()
  })

  it("renders a lone tool call as a standard card (no group)", () => {
    render(<MessageRenderer message={toolMsg("g2", "tool-SomeTool")} />)
    expect(document.querySelector("[data-test='activity-group']")).toBeNull()
    expect(document.querySelector("[data-test='tool']")).toBeTruthy()
  })

  it("renders a lone tool call as a compact row in simplified mode", () => {
    mockFlowMode = "simplified"
    render(<MessageRenderer message={toolMsg("g3", "tool-SomeTool")} />)
    const row = document.querySelector("[data-test='tool-call-row']")
    expect(row).toBeTruthy()
    expect(row?.getAttribute("data-type")).toBe("tool-SomeTool")
    expect(document.querySelector("[data-test='tool']")).toBeNull()
  })

  it("forwards the active mode to the activity group", () => {
    mockFlowMode = "detailed"
    render(<MessageRenderer message={toolMsg("g4", "tool-A", "tool-B", "tool-C")} />)
    const group = document.querySelector("[data-test='activity-group']")
    expect(group?.getAttribute("data-mode")).toBe("detailed")
    expect(group?.getAttribute("data-count")).toBe("3")
  })

  // A model that emits no prose between two tool calls still produces an empty
  // text part. It must not split the run into two groups.
  it("keeps one activity group across an empty text part between tool calls", () => {
    const msg = {
      id: "g5",
      role: "assistant",
      parts: [
        { type: "tool-A", state: "output-available", input: {} },
        { type: "text", text: "" },
        { type: "tool-B", state: "output-available", input: {} },
      ],
    } as unknown as UIMessage
    render(<MessageRenderer message={msg} />)
    const groups = document.querySelectorAll("[data-test='activity-group']")
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute("data-count")).toBe("2")
    expect(groups[0].querySelectorAll("[data-test='tool']")).toHaveLength(2)
  })

  it("still breaks the run when the model writes prose between tool calls", () => {
    const msg = {
      id: "g6",
      role: "assistant",
      parts: [
        { type: "tool-A", state: "output-available", input: {} },
        { type: "tool-B", state: "output-available", input: {} },
        { type: "text", text: "Now let me run it." },
        { type: "tool-C", state: "output-available", input: {} },
      ],
    } as unknown as UIMessage
    render(<MessageRenderer message={msg} />)
    expect(document.querySelectorAll("[data-test='activity-group']")).toHaveLength(1)
    expect(screen.getByText("Now let me run it.")).toBeInTheDocument()
  })

  it("renders nothing for an empty text part", () => {
    const msg = {
      id: "g7",
      role: "assistant",
      parts: [{ type: "text", text: "   " }],
    } as unknown as UIMessage
    render(<MessageRenderer message={msg} />)
    expect(document.querySelector("[data-test='markdown']")).toBeNull()
  })
})

// ── display-mode reactivity (standard ⇄ detailed) ─────────────────────────────
//
// standard and detailed differ ONLY in the `defaultOpen`/`forceOpen` handed to
// each tool card's (and reasoning block's) uncontrolled Collapsible, which is
// read once at mount. So flipping the header switch on an already-rendered
// transcript changed the prop but never re-opened/re-collapsed a mounted card —
// the "standard and detailed look identical" bug. The renderer folds the mode
// into the KEY of just the mode-sensitive parts so a mode switch remounts them
// and re-applies the per-mode default, while leaving prose untouched.
describe("display-mode reactivity (standard ⇄ detailed)", () => {
  afterEach(() => {
    mockFlowMode = "standard"
  })

  function loneToolMsg(id: string): UIMessage {
    return {
      id,
      role: "assistant",
      parts: [{ type: "tool-SomeTool", state: "output-available", input: {} }],
    } as unknown as UIMessage
  }

  // In production a mode switch re-renders MessageRenderer via the settings-store
  // subscription inside `useAgentFlowMode`. That hook is mocked here (reads a
  // module var), and MessageRenderer is `memo`'d on its props, so a bare
  // `rerender` with identical props would bail out and never re-read the mode.
  // Handing a fresh `onRegenerate` reference each render defeats the memo the
  // same way a real store update would (it renders nothing without
  // `isLastAssistant`), so the component re-runs and picks up `mockFlowMode`.
  const forceRender = () => ({ onRegenerate: () => {} })

  it("reuses the tool-card DOM node across a re-render at the same mode", () => {
    mockFlowMode = "standard"
    const msg = loneToolMsg("mode-stable")
    const { rerender } = render(<MessageRenderer message={msg} {...forceRender()} />)
    const first = document.querySelector("[data-test='tool']")
    expect(first).toBeTruthy()
    rerender(<MessageRenderer message={msg} {...forceRender()} />)
    // Stable key at an unchanged mode → React keeps the same node (no
    // gratuitous remount that would drop the user's manual card state).
    expect(document.querySelector("[data-test='tool']")).toBe(first)
  })

  it("remounts the lone tool card when the mode switches standard → detailed", () => {
    mockFlowMode = "standard"
    const msg = loneToolMsg("mode-remount")
    const { rerender } = render(<MessageRenderer message={msg} {...forceRender()} />)
    const first = document.querySelector("[data-test='tool']")
    expect(first).toBeTruthy()
    mockFlowMode = "detailed"
    rerender(<MessageRenderer message={msg} {...forceRender()} />)
    const second = document.querySelector("[data-test='tool']")
    expect(second).toBeTruthy()
    // Mode folded into the key → the card remounts so its new per-mode
    // `defaultOpen` takes effect (detailed expands what standard collapsed).
    expect(second).not.toBe(first)
  })

  it("remounts the activity group when the mode switches standard → detailed", () => {
    mockFlowMode = "standard"
    const msg = {
      id: "grp-remount",
      role: "assistant",
      parts: [
        { type: "tool-A", state: "output-available", input: {} },
        { type: "tool-B", state: "output-available", input: {} },
      ],
    } as unknown as UIMessage
    const { rerender } = render(<MessageRenderer message={msg} {...forceRender()} />)
    const first = document.querySelector("[data-test='activity-group']")
    expect(first).toBeTruthy()
    expect(first?.getAttribute("data-mode")).toBe("standard")
    mockFlowMode = "detailed"
    rerender(<MessageRenderer message={msg} {...forceRender()} />)
    const second = document.querySelector("[data-test='activity-group']")
    expect(second?.getAttribute("data-mode")).toBe("detailed")
    expect(second).not.toBe(first)
  })

  it("remounts a reasoning block when the mode switches standard → detailed", () => {
    mockFlowMode = "standard"
    const msg = {
      id: "reason-remount",
      role: "assistant",
      parts: [{ type: "reasoning", text: "thinking", state: "done" }],
    } as unknown as UIMessage
    const { rerender } = render(<MessageRenderer message={msg} {...forceRender()} />)
    const first = document.querySelector("[data-test='reasoning']")
    expect(first).toBeTruthy()
    mockFlowMode = "detailed"
    rerender(<MessageRenderer message={msg} {...forceRender()} />)
    const second = document.querySelector("[data-test='reasoning']")
    expect(second).not.toBe(first)
  })

  it("leaves prose untouched when the mode switches (mode-agnostic key)", () => {
    mockFlowMode = "standard"
    const msg = assistantMsg("prose-stable", "Hello there")
    const { rerender } = render(<MessageRenderer message={msg} {...forceRender()} />)
    const first = document.querySelector("[data-test='markdown']")
    expect(first).toBeTruthy()
    mockFlowMode = "detailed"
    rerender(<MessageRenderer message={msg} {...forceRender()} />)
    // Prose is not mode-sensitive, so a toggle must not remount it (no reflow).
    expect(document.querySelector("[data-test='markdown']")).toBe(first)
  })
})

// ── action bar suppression ────────────────────────────────────────────────────

describe("action bar on tool-only turns", () => {
  function toolOnlyMsg(id: string): UIMessage {
    return {
      id,
      role: "assistant",
      parts: [
        { type: "tool-A", state: "output-available", input: {} },
        { type: "tool-B", state: "output-available", input: {} },
      ],
    } as unknown as UIMessage
  }

  // The bar is opacity-0 until hover but still reserves a ~40px row, which put
  // a strip of chrome between every pair of consecutive tool calls.
  it("renders no action bar for a turn that is only tool calls", () => {
    render(<MessageRenderer message={toolOnlyMsg("t1")} isLastAssistant />)
    expect(document.querySelector("[data-test='message-actions']")).toBeNull()
    expect(screen.queryByLabelText("copyTooltip")).toBeNull()
    expect(screen.queryByLabelText("bookmarkTooltip")).toBeNull()
  })

  it("keeps the action bar once the turn carries prose", () => {
    render(<MessageRenderer message={assistantMsg("t2", "Done.")} isLastAssistant />)
    expect(document.querySelector("[data-test='message-actions']")).toBeTruthy()
    expect(screen.getByLabelText("copyTooltip")).toBeInTheDocument()
  })

  it("keeps the action bar on a tool turn that also wrote prose", () => {
    const msg = {
      id: "t3",
      role: "assistant",
      parts: [
        { type: "tool-A", state: "output-available", input: {} },
        { type: "text", text: "All set." },
      ],
    } as unknown as UIMessage
    render(<MessageRenderer message={msg} isLastAssistant />)
    expect(document.querySelector("[data-test='message-actions']")).toBeTruthy()
  })

  it("keeps the action bar on user messages", () => {
    render(<MessageRenderer message={userMsg("t4")} />)
    expect(document.querySelector("[data-test='message-actions']")).toBeTruthy()
  })
})

// ── column width ──────────────────────────────────────────────────────────────

describe("message column width", () => {
  // `w-fit` lets the column follow its widest mounted child, so collapsing a
  // tool card (which unmounts its body) snapped the whole column narrow.
  it("pins the assistant column to the full row so expand/collapse cannot move it", () => {
    render(<MessageRenderer message={assistantMsg("w1")} />)
    const content = document.querySelector("[data-test='message-content']")
    expect(content?.className).toContain("group-[.is-assistant]:w-full")
  })

  it("uses a compact bubble for the user and an open full-width assistant turn", () => {
    const { rerender } = render(<MessageRenderer message={userMsg("w2")} />)
    expect(document.querySelector("[data-test='message']")).toHaveClass("max-w-[min(82%,42rem)]")
    expect(document.querySelector("[data-test='message-content']")).toHaveClass(
      "group-[.is-user]:rounded-2xl",
      "group-[.is-user]:bg-muted/70"
    )

    rerender(<MessageRenderer message={assistantMsg("w3")} />)
    expect(document.querySelector("[data-test='message']")).toHaveClass("max-w-full")
  })
})
