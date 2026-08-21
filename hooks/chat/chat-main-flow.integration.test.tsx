/**
 * @jest-environment jsdom
 *
 * Chat main-flow INTEGRATION test (主链路).
 *
 * This reproduces the real send → stream → render pipeline end to end, faking
 * ONLY the sidecar binary boundary. Unlike `use-claude-chat.test.ts` (a pure
 * hook unit test that stubs `applySdkEvent` AND the chat-store), this test keeps
 * BOTH real:
 *
 *   - `@/lib/claude/adapter`  → real `applySdkEvent` folds SDK events to bubbles
 *   - `@/stores/chat`         → real Zustand store holds the session messages
 *
 * What we fake:
 *   - `@/lib/claude/ipc`      → `sendPrompt` (assert the claude_send call) and
 *                               `onClaudeMessage` (capture the handler so we can
 *                               inject fake `claude://message` events ourselves)
 *   - DB / goal / loop / plugin-bus / external-agent → no-op side channels that
 *     would otherwise reach Dexie / an LLM. These are NOT the main flow.
 *
 * The flow under test (all real except the sidecar):
 *   1. user types + clicks send
 *   2. useClaudeChat.send → optimistic user bubble in the real store (sync)
 *   3. send → sendPrompt("claude_send", …)  ← the sidecar boundary, asserted
 *   4. we inject an SDKEventEnvelope assistant event on the captured handler
 *   5. real handleEvent → real applySdkEvent → real store → assistant bubble
 *
 * Streaming determinism: the per-session commit coalescer degrades to a
 * synchronous write when `requestAnimationFrame` is undefined (see
 * stream-coalescing.ts:45-49), so we stub rAF off for the suite.
 *
 * Rendering: a thin transcript view reads the SAME real store the production
 * `<MessageList>` reads (via `useSessionMessages`/`useSessionStatus`). Swapping
 * in the real `<MessageList>` is a follow-up increment — it pulls markdown /
 * react-virtual / characters-context / a logger that need their own mocks.
 *
 * NB: this suite logs a handful of React "not configured to support act(...)"
 * dev warnings. They are benign: the REAL send pipeline does deliberately
 * detached, fire-and-forget async (the per-session event queue + send's internal
 * continuations) whose zustand `useSyncExternalStore` re-renders land after any
 * test-side `act` await can reach them. Every assertion below is on flushed,
 * deterministic state. Taming them fully (fake timers) is part of increment 2.
 */

import { useState } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// ---- sidecar / platform boundary -----------------------------------------
// `stores/index.ts` calls `isTauri()` at module top-level; declaring the mock
// inside the factory dodges the import-hoist TDZ.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(true),
}))
// This suite exercises the desktop sidecar boundary specifically. Runtime
// target resolution otherwise classifies jsdom as an unpaired web browser and
// correctly takes the standalone in-renderer path instead of `sendPrompt`.
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: jest.fn(() => false),
}))
// Task Workspace isolation is GA, so a turn with a `cwd` now always asks the
// host for a run lease. This suite has no Tauri transport behind that call, and
// a real host that cannot serve it answers "unknown command" (which
// `beginTaskWorkspaceTurn` maps to `null`). Model that answer directly.
jest.mock("@/lib/task-workspace/run-lease", () => ({
  ...jest.requireActual("@/lib/task-workspace/run-lease"),
  openTaskWorkspaceRunLease: jest.fn(async () => null),
}))

const onClaudeUnsub = jest.fn()
let messageCallback: ((evt: unknown) => void) | null = null
const onClaudeMessageMock = jest.fn(async (cb: (evt: unknown) => void) => {
  messageCallback = cb
  return onClaudeUnsub
})
const sendPromptMock = jest.fn().mockResolvedValue(undefined)
const approveToolMock = jest.fn().mockResolvedValue(undefined)
const toolResultDecisionMock = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/claude/ipc", () => ({
  approveTool: (...a: unknown[]) => approveToolMock(...a),
  closeSession: jest.fn().mockResolvedValue(undefined),
  interruptSession: jest.fn().mockResolvedValue(undefined),
  onClaudeMessage: (cb: (evt: unknown) => void) => onClaudeMessageMock(cb),
  sendPrompt: (...a: unknown[]) => sendPromptMock(...a),
  toolResultDecision: (...a: unknown[]) => toolResultDecisionMock(...a),
}))

// ---- side channels that would otherwise hit Dexie / an LLM ----------------
// NB: `@/lib/claude/adapter` is intentionally NOT mocked — real fold.
jest.mock("@/lib/claude/sdk-subagent-bridge", () => ({
  applySdkSubagentBridge: jest.fn(),
  __resetSdkSubagentBridge: () => {},
}))

jest.mock("@/lib/plugin/messaging/message-bus", () => {
  const actual = jest.requireActual("@/lib/plugin/messaging/message-bus")
  return { ...actual, emitSystemBusEvent: jest.fn() }
})

jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({
    getActiveGoalForSession: jest.fn().mockResolvedValue(undefined),
    pauseGoal: jest.fn().mockResolvedValue(null),
    registerAbortController: jest.fn(() => () => {}),
    onManualContinue: jest.fn(() => () => {}),
    requestManualContinue: jest.fn(),
    recordPacingDecision: jest.fn().mockResolvedValue(undefined),
  }),
}))
jest.mock("@/lib/loop/runtime", () => ({
  getLoopRuntime: () => ({
    getActiveLoopForSession: jest.fn().mockResolvedValue(undefined),
    pauseLoop: jest.fn().mockResolvedValue(null),
    registerAbortController: jest.fn(() => () => {}),
    onKickoff: jest.fn((_cb: (loop: unknown) => void) => () => {}),
  }),
}))
jest.mock("@/lib/loop/turn-driver", () => ({ handleLoopTurnComplete: jest.fn() }))
jest.mock("@/lib/goal/turn-driver", () => ({ handleTurnComplete: jest.fn() }))
jest.mock("@/lib/goal/judge-client", () => ({ buildGoalJudgeClient: jest.fn() }))

jest.mock("@/lib/db/messages", () => ({
  listMessages: jest.fn().mockResolvedValue([]),
  persistMessages: jest.fn().mockResolvedValue(undefined),
  persistStreamingMessages: jest.fn().mockResolvedValue(undefined),
  truncateAfter: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn().mockResolvedValue(undefined),
  setSdkSessionId: jest.fn().mockResolvedValue(undefined),
  touchSession: jest.fn().mockResolvedValue(undefined),
  updateSession: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/db/session-state", () => ({ bumpUnread: jest.fn().mockResolvedValue(undefined) }))
// Per-turn cost/usage accounting fires on the `result` seal — keep it off Dexie
// and capture the call so the full-turn test can assert the turn was accounted.
const recordResultUsageMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/session-usage", () => ({
  recordResultUsage: (...a: unknown[]) => recordResultUsageMock(...a),
}))

jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ model: "sonnet", systemPrompt: "sys" })),
}))
jest.mock("@/lib/claude/adapter-hooks", () => {
  // Keep the REAL tool-hook dispatchers (dispatchPreToolUse/dispatchPostToolUse/
  // hasPostToolUseListeners) — the W3.1 tests below drive them through the real
  // hooks-system. Only the prompt/error/usage side channels stay stubbed.
  const actual = jest.requireActual("@/lib/claude/adapter-hooks")
  return {
    ...actual,
    dispatchUserPromptSubmit: jest.fn(async () => ({ action: "proceed" as const })),
    dispatchChatError: jest.fn(),
    dispatchTokenUsage: jest.fn(),
    dispatchPostChatReceive: jest.fn(async () => ({})),
  }
})
jest.mock("@/lib/ai/agent/external/manager", () => ({
  executeOnExternalAgent: jest.fn(),
  getExternalAgentManager: () => ({
    getConnectedAgents: () => [],
    checkDelegation: () => ({ shouldDelegate: false }),
    setDelegationRules: jest.fn(),
  }),
}))
jest.mock("@/lib/ai/agent/external/event-to-parts", () => ({
  applyExternalAgentEventToParts: (parts: unknown) => parts ?? [],
}))
// Title generation is a detached fire-and-forget task in send's tail; skip it
// so its background store write doesn't fire after the test's act scope.
jest.mock("@/lib/ai/generation/run-title-task", () => ({
  runTitleTask: jest.fn().mockResolvedValue(undefined),
  shouldGenerateTitle: jest.fn(() => false),
  isPlaceholderTitle: jest.fn(() => false),
}))

// Real imports AFTER the mocks.
import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import { useChatStore, useSessionMessages, useSessionStatus } from "@/stores/chat"
import type { UIMessage } from "ai"

const SID = "ses-main-flow"

// A faithful-but-thin transcript: reads the SAME real store the production
// MessageList reads, and renders each message's text parts as a bubble.
function Transcript({ sessionId }: { sessionId: string }) {
  const messages: UIMessage[] = useSessionMessages(sessionId)
  const status = useSessionStatus(sessionId)
  return (
    <div data-testid="transcript" data-status={status}>
      {messages.map((m) => (
        <div key={m.id} data-testid={`bubble-${m.role}`}>
          {m.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p, i) => (
              <span key={i}>{p.text}</span>
            ))}
        </div>
      ))}
    </div>
  )
}

// The latest in-flight send promise, captured from the real onClick handler so
// the test can await the FULL send chain inside `act` (send is fire-and-forget
// from the composer, so its post-`await` store writes would otherwise land
// outside any act scope and trip React's dev-mode act checker).
let lastSend: Promise<unknown> | null = null

// The minimal "chat interface": real composer-style input + real send + real
// transcript, all driven by the real useClaudeChat hook.
function ChatHarness() {
  const chat = useClaudeChat()
  const [text, setText] = useState("")
  return (
    <div>
      <textarea aria-label="message" value={text} onChange={(e) => setText(e.target.value)} />
      <button
        type="button"
        onClick={() => {
          lastSend = chat.send(text, undefined, { sessionId: SID })
        }}
      >
        send
      </button>
      <Transcript sessionId={SID} />
    </div>
  )
}

// Click "send" through the real composer and await the full send chain in act.
async function clickSend(user: ReturnType<typeof userEvent.setup>) {
  await act(async () => {
    await user.click(screen.getByRole("button", { name: "send" }))
    await lastSend
    await settle()
  })
}

// rAF off → the streaming commit coalescer writes synchronously.
const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame
beforeAll(() => {
  // @ts-expect-error — deliberately removing rAF to force the sync commit path.
  globalThis.requestAnimationFrame = undefined
  // @ts-expect-error — same.
  globalThis.cancelAnimationFrame = undefined
})
afterAll(() => {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
})

beforeEach(() => {
  jest.clearAllMocks()
  messageCallback = null
  // Fresh, open, active session in the real store.
  act(() => {
    useChatStore.getState().closeSession(SID)
    useChatStore.getState().setActiveSession(SID)
  })
})

// Push an event through the captured sidecar handler and let the per-session
// async queue + any 0ms persist debounce settle.
async function dispatchSidecar(evt: unknown) {
  await act(async () => {
    messageCallback?.(evt)
    await settle()
  })
}

// `send` is fire-and-forget from the composer's onClick, so its promise chain
// (prompt-submit → resolveSendOptions → sendPrompt → post-receive) resolves
// detached over several ticks. Drain enough microtasks + a macrotask so all of
// its trailing store writes land inside an `act` scope (no act warnings).
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe("chat main flow (integration)", () => {
  it("send routes the prompt to the sidecar and optimistically renders the user bubble", async () => {
    const user = userEvent.setup()
    render(<ChatHarness />)

    await user.type(screen.getByLabelText("message"), "Hello from the user")
    await clickSend(user)

    // 3. the sidecar boundary was crossed with the typed content.
    expect(sendPromptMock).toHaveBeenCalledTimes(1)
    expect(sendPromptMock).toHaveBeenCalledWith(
      SID,
      "Hello from the user",
      expect.objectContaining({ model: "sonnet" })
    )

    // 2. real makeUserMessage → real store → user bubble rendered.
    expect(screen.getByTestId("bubble-user")).toHaveTextContent("Hello from the user")
    // Real-behavior note: `send` sets "streaming" then immediately clears any
    // prior error with `setSessionError(id, null)`, which `statusPatch` lands at
    // "idle" (chat-store.ts:563-568). "streaming" is minted by the FIRST SDK
    // event, not by the synchronous send — so post-send the status is "idle".
    expect(screen.getByTestId("transcript")).toHaveAttribute("data-status", "idle")
  })

  it("folds an injected assistant stream event into a rendered assistant bubble", async () => {
    const user = userEvent.setup()
    render(<ChatHarness />)

    await user.type(screen.getByLabelText("message"), "ping")
    await clickSend(user)
    expect(screen.getByTestId("bubble-user")).toHaveTextContent("ping")

    // 4 + 5. Inject a real-shaped assistant SDK event on the sidecar channel.
    // SDKEventEnvelope { type: "event", sessionId, event: SDKMessage }.
    await dispatchSidecar({
      type: "event",
      sessionId: SID,
      event: {
        type: "assistant",
        uuid: "evt-1",
        session_id: SID,
        parent_tool_use_id: null,
        message: {
          id: "asst-1",
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
        },
      },
    })

    // The real applySdkEvent fold landed in the real store → bubble rendered,
    // and the optimistic user bubble survived the fold.
    await waitFor(() => {
      expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("hi there")
    })
    expect(screen.getByTestId("bubble-user")).toHaveTextContent("ping")
  })

  // A token-level `stream_event` envelope: `message_start` seeds the empty
  // assistant message; each `content_block_delta` (text_delta) grows it. The
  // real `applyStreamEvent` fold (adapter.ts:493) accumulates the chunks, and —
  // with rAF stubbed off — the coalescer commits each delta synchronously, so
  // the bubble visibly grows between dispatches. This is the live "typing out"
  // experience the user sees, which the single-assistant-event test above skips.
  it("accumulates streamed text deltas into a growing assistant bubble", async () => {
    const user = userEvent.setup()
    render(<ChatHarness />)

    await user.type(screen.getByLabelText("message"), "tell me a story")
    await clickSend(user)

    // The stream_event SDKMessage carries the raw Anthropic event in `.event`.
    const streamEvent = (raw: unknown) => ({
      type: "event",
      sessionId: SID,
      event: {
        type: "stream_event",
        uuid: "stream-1",
        session_id: SID,
        parent_tool_use_id: null,
        event: raw,
      },
    })

    // message_start → an empty assistant message keyed by the Anthropic id.
    await dispatchSidecar(streamEvent({ type: "message_start", message: { id: "asst-stream" } }))

    // First delta → the bubble appears with the opening chunk.
    await dispatchSidecar(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Once " },
      })
    )
    await waitFor(() => {
      expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("Once")
    })

    // Second delta → the SAME bubble grows; the chunk is appended, not replaced.
    await dispatchSidecar(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "upon a time." },
      })
    )
    await waitFor(() => {
      expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("Once upon a time.")
    })
    // Still a single assistant bubble — deltas folded into one message, not many.
    expect(screen.getAllByTestId("bubble-assistant")).toHaveLength(1)
    expect(screen.getByTestId("bubble-user")).toHaveTextContent("tell me a story")
  })

  // Conversation continuity: after the first reply lands, a second send must
  // route to the sidecar again (the turn went idle, so the busy-gate at
  // use-claude-chat.ts:731 lets it through) and the transcript must hold BOTH
  // exchanges in order — proving messages accumulate across turns, not reset.
  it("continues the conversation across a second turn", async () => {
    const user = userEvent.setup()
    render(<ChatHarness />)

    // Turn 1: prompt → reply.
    await user.type(screen.getByLabelText("message"), "first question")
    await clickSend(user)
    await dispatchSidecar({
      type: "event",
      sessionId: SID,
      event: {
        type: "assistant",
        uuid: "evt-1",
        session_id: SID,
        parent_tool_use_id: null,
        message: {
          id: "asst-1",
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
        },
      },
    })
    await waitFor(() => {
      expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("first answer")
    })

    // Turn 2: a fresh prompt on the same session.
    await user.clear(screen.getByLabelText("message"))
    await user.type(screen.getByLabelText("message"), "second question")
    await clickSend(user)

    // The sidecar saw both turns, the second carrying the new prompt.
    expect(sendPromptMock).toHaveBeenCalledTimes(2)
    expect(sendPromptMock).toHaveBeenLastCalledWith(
      SID,
      "second question",
      expect.objectContaining({ model: "sonnet" })
    )

    await dispatchSidecar({
      type: "event",
      sessionId: SID,
      event: {
        type: "assistant",
        uuid: "evt-2",
        session_id: SID,
        parent_tool_use_id: null,
        message: {
          id: "asst-2",
          role: "assistant",
          content: [{ type: "text", text: "second answer" }],
        },
      },
    })

    // The transcript holds the full ordered history: both turns survived.
    await waitFor(() => {
      expect(screen.getAllByTestId("bubble-assistant")).toHaveLength(2)
    })
    const users = screen.getAllByTestId("bubble-user").map((n) => n.textContent)
    const assistants = screen.getAllByTestId("bubble-assistant").map((n) => n.textContent)
    expect(users).toEqual(["first question", "second question"])
    expect(assistants).toEqual(["first answer", "second answer"])
  })

  // The complete turn lifecycle, all real except the sidecar:
  //   stream deltas → a live preview bubble grows
  //   canonical `assistant` (SAME Anthropic message id) → REPLACES the preview
  //     in place (adapter.ts:417 keys by id), so partial tokens don't duplicate
  //   `result` → seals the turn: status settles idle, per-turn usage is recorded
  // This is the seam the earlier tests stop short of (`result` was "increment 2").
  it("seals a full streamed turn: canonical message replaces the preview, result records usage", async () => {
    const user = userEvent.setup()
    render(<ChatHarness />)

    await user.type(screen.getByLabelText("message"), "say hi")
    await clickSend(user)

    const MID = "asst-final" // one Anthropic message id across preview + canonical
    const streamEvent = (raw: unknown) => ({
      type: "event",
      sessionId: SID,
      event: {
        type: "stream_event",
        uuid: "stream-x",
        session_id: SID,
        parent_tool_use_id: null,
        event: raw,
      },
    })

    // Live preview: message_start + a partial delta.
    await dispatchSidecar(streamEvent({ type: "message_start", message: { id: MID } }))
    await dispatchSidecar(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      })
    )
    await waitFor(() => {
      expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("Hel")
    })

    // Canonical full message with the SAME id → replaces the preview in place.
    await dispatchSidecar({
      type: "event",
      sessionId: SID,
      event: {
        type: "assistant",
        uuid: "evt-final",
        session_id: SID,
        parent_tool_use_id: null,
        message: { id: MID, role: "assistant", content: [{ type: "text", text: "Hello, world!" }] },
      },
    })
    await waitFor(() => {
      expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("Hello, world!")
    })
    // Replaced, not concatenated — no "HelHello, world!", and still one bubble.
    expect(screen.getByTestId("bubble-assistant").textContent).toBe("Hello, world!")
    expect(screen.getAllByTestId("bubble-assistant")).toHaveLength(1)

    // The `result` event seals the turn.
    await dispatchSidecar({
      type: "event",
      sessionId: SID,
      event: {
        type: "result",
        subtype: "success",
        uuid: "res-1",
        session_id: SID,
        parent_tool_use_id: null,
      },
    })

    // Turn accounted: per-turn usage recorded for THIS session's final message.
    await waitFor(() => expect(recordResultUsageMock).toHaveBeenCalledTimes(1))
    expect(recordResultUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SID, messageId: MID })
    )
    // Settled: the turn is idle and the conversation is intact.
    expect(screen.getByTestId("transcript")).toHaveAttribute("data-status", "idle")
    expect(screen.getByTestId("bubble-user")).toHaveTextContent("say hi")
    expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("Hello, world!")
  })
})

// ── W3.1: plugin tool hooks over the real chat pump ──────────────────────────
// A plugin's `onPreToolUse` deny must resolve the sidecar's canUseTool
// round-trip (claude_approve deny) before any user-facing approval flow, and
// `onPostToolUse` must answer `tool_result_review` with the rewritten output.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { usePluginStore } = require("@/stores/plugin-runtime") as {
  usePluginStore: {
    getState: () => Record<string, unknown>
    setState: (s: Record<string, unknown>) => void
  }
}

function seedHookPlugin(hooks: Record<string, unknown>) {
  usePluginStore.setState({
    plugins: {
      "tool-firewall": {
        manifest: { id: "tool-firewall", name: "Tool Firewall", version: "1.0.0" },
        status: "enabled",
        source: "builtin",
        path: "builtin://tool-firewall",
        config: {},
        hooks,
      },
    },
  })
}

describe("plugin tool hooks (W3.1 integration)", () => {
  afterEach(() => {
    usePluginStore.setState({ plugins: {} })
  })

  it("onPreToolUse deny blocks the tool before any approval flow", async () => {
    const onPreToolUse = jest.fn().mockResolvedValue({ action: "deny", reason: "firewalled" })
    seedHookPlugin({ onPreToolUse })
    render(<ChatHarness />)
    await waitFor(() => expect(messageCallback).not.toBeNull())

    await dispatchSidecar({
      type: "permission_request",
      sessionId: SID,
      requestId: "req-1",
      toolUseID: "tu-1",
      toolName: "Bash",
      input: { command: "rm -rf /" },
    })

    await waitFor(() =>
      expect(approveToolMock).toHaveBeenCalledWith(SID, "req-1", "deny", "firewalled")
    )
    expect(onPreToolUse).toHaveBeenCalledWith("Bash", { command: "rm -rf /" }, SID)
  })

  it("onPreToolUse modify approves with the rewritten args", async () => {
    const onPreToolUse = jest
      .fn()
      .mockResolvedValue({ action: "modify", modifiedArgs: { command: "ls" } })
    seedHookPlugin({ onPreToolUse })
    render(<ChatHarness />)
    await waitFor(() => expect(messageCallback).not.toBeNull())

    await dispatchSidecar({
      type: "permission_request",
      sessionId: SID,
      requestId: "req-2",
      toolUseID: "tu-2",
      toolName: "Bash",
      input: { command: "rm -rf /" },
    })

    await waitFor(() =>
      expect(approveToolMock).toHaveBeenCalledWith(SID, "req-2", "allow", undefined, {
        command: "ls",
      })
    )
  })

  it("onPostToolUse rewrite reaches the tool_result_review decision", async () => {
    const onPostToolUse = jest.fn().mockResolvedValue({ modifiedResult: "REDACTED" })
    seedHookPlugin({ onPostToolUse })
    render(<ChatHarness />)
    await waitFor(() => expect(messageCallback).not.toBeNull())

    // Seed the call correlation the same way the pump does (permission ask).
    await dispatchSidecar({
      type: "permission_request",
      sessionId: SID,
      requestId: "req-3",
      toolUseID: "tu-3",
      toolName: "Read",
      input: { file_path: "/etc/passwd" },
    })

    await dispatchSidecar({
      type: "tool_result_review",
      sessionId: SID,
      reviewId: "rev-1",
      toolUseId: "tu-3",
      toolName: "Read",
      result: "root:x:0:0",
      isError: false,
    })

    await waitFor(() =>
      expect(toolResultDecisionMock).toHaveBeenCalledWith(SID, "rev-1", "REDACTED", undefined)
    )
    expect(onPostToolUse).toHaveBeenCalledWith(
      "Read",
      { file_path: "/etc/passwd" },
      "root:x:0:0",
      SID
    )
  })
})

// ── W3.3: message pipeline hooks (onMessageSend / onMessageReceive) ──────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPluginLifecycleHooks } = require("@/lib/plugin/messaging/hooks-system") as {
  getPluginLifecycleHooks: () => {
    registerHooks: (id: string, hooks: Record<string, unknown>) => void
    unregisterHooks: (id: string) => void
  }
}

describe("plugin message pipeline (W3.3 integration)", () => {
  afterEach(() => {
    getPluginLifecycleHooks().unregisterHooks("pipeline-plugin")
  })

  it("onMessageSend rewrites the outgoing user message before the sidecar", async () => {
    getPluginLifecycleHooks().registerHooks("pipeline-plugin", {
      onMessageSend: async (m: { content: string }) => ({ ...m, content: `${m.content} [signed]` }),
    })
    const user = userEvent.setup()
    render(<ChatHarness />)
    await waitFor(() => expect(messageCallback).not.toBeNull())
    await user.type(screen.getByLabelText("message"), "hello there")
    await clickSend(user)

    expect(sendPromptMock).toHaveBeenCalledWith(
      SID,
      "hello there [signed]",
      expect.objectContaining({ model: "sonnet" })
    )
  })

  it("onMessageReceive rewrites the sealed assistant message in the transcript", async () => {
    getPluginLifecycleHooks().registerHooks("pipeline-plugin", {
      onMessageReceive: async (m: { content: string }) => ({ ...m, content: "REWRITTEN" }),
    })
    const user = userEvent.setup()
    render(<ChatHarness />)
    await waitFor(() => expect(messageCallback).not.toBeNull())
    await user.type(screen.getByLabelText("message"), "say hi")
    await clickSend(user)

    await dispatchSidecar({
      type: "event",
      sessionId: SID,
      event: {
        type: "assistant",
        uuid: "a-pipe-1",
        session_id: SID,
        parent_tool_use_id: null,
        message: {
          id: "m-pipe-1",
          role: "assistant",
          content: [{ type: "text", text: "original answer" }],
        },
      },
    })
    await dispatchSidecar({
      type: "event",
      sessionId: SID,
      event: {
        type: "result",
        subtype: "success",
        uuid: "res-pipe-1",
        session_id: SID,
        parent_tool_use_id: null,
      },
    })

    await waitFor(() =>
      expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("REWRITTEN")
    )
  })
})
