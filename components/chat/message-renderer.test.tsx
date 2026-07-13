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
jest.mock("@/components/chat/message-parts/tool-activity-group", () => ({
  ToolActivityGroup: ({ entries, mode }: { entries: unknown[]; mode: string }) =>
    ReactForMocks.createElement("div", {
      "data-test": "activity-group",
      "data-mode": mode,
      "data-count": entries.length,
    }),
}))
jest.mock("@/components/chat/message-parts/tool-call-row", () => ({
  ToolCallRow: ({ part }: { part: { type: string } }) =>
    ReactForMocks.createElement("div", { "data-test": "tool-call-row", "data-type": part.type }),
}))

import { render, screen, fireEvent } from "@testing-library/react"
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
    const errNode = document.querySelector("[data-testid='plugin-part-error']")
    expect(errNode).toBeTruthy()
    expect(errNode?.getAttribute("data-plugin-id")).toBe("bad-plugin")
    expect(errNode?.getAttribute("data-part-type")).toBe("broken")
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
    // The individual cards are owned by the group, not rendered standalone.
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
})
