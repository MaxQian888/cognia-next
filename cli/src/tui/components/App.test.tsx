import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import React from "react"
import { act, render, waitFor } from "@testing-library/react"
import { __fireInput, __resetInk, __suspendTerminal } from "ink"

// Stub the durable history store so submitting in these tests never touches the
// real `~/.cognia/history.json` (most cases render without an injected `home`).
jest.mock("../input/history-store", () => ({
  appendHistory: jest.fn(),
  loadHistory: jest.fn(() => []),
}))

// The default model-meta resolver reads the real models.dev catalog and would
// dispatch SET_MODEL_META on a microtask after render — firing an act() warning
// in the synchronous-render cases below. Stub it to a never-settling promise so
// the effect is inert unless a test injects its own `resolveMeta` prop.
jest.mock("../runtime/model-meta", () => ({
  resolveModelMeta: () => new Promise(() => {}),
}))

jest.mock("../../agent/subagent-background-tasks", () => ({
  countRunningCliBackgroundRuns: jest.fn(() => 0),
  countInterruptedCliBackgroundRuns: jest.fn(() => new Promise(() => {})),
}))

jest.mock("@/plugins/cognia-builtin-characters/src/index", () => ({
  BUILTIN_LEGACY_ID_TO_LOCAL_ID: {},
  BUILTIN_PACK: { id: "builtin", version: "1.0.0", characters: [] },
  BUILTIN_PLUGIN_ID: "cognia-builtin-characters",
}))

// marked@18 is ESM-only; this suite exercises App orchestration rather than
// markdown tokenization, which has its own focused tests.
jest.mock("../render/cell-terminal-block", () => ({
  cellToTerminalBlock: (cell: { id?: string; text?: string; raw?: string; result?: string }) => {
    const plainText = cell.text ?? cell.raw ?? cell.result ?? ""
    return {
      id: cell.id ?? "cell",
      plainText,
      rowCount: 1,
      lines: [{ plain: plainText, spans: [{ text: plainText, style: "plain" }] }],
    }
  },
  TerminalBlockCache: class {
    get(_key: unknown, build: () => unknown) {
      return build()
    }
    stats() {
      return { hits: 0, misses: 0, size: 0, hitRate: 0 }
    }
  },
}))
jest.mock("./Markdown", () => ({
  Markdown: ({ raw }: { raw: string }) => raw,
  MarkdownLine: ({ line }: { line: { spans?: Array<{ text?: string }> } }) =>
    line.spans?.map((span) => span.text ?? "").join("") ?? "",
}))
jest.mock("../markdown/tokenize", () => ({
  tokenizeMarkdown: (raw: string) =>
    raw.split("\n").map((text) => ({ kind: "paragraph", spans: [{ text }] })),
}))
jest.mock("../../handoff/host-state-client", () => ({
  attachLocalHost: jest.fn(),
  attachedHostStatus: jest.fn(async () => null),
  detachLocalHost: jest.fn(),
  flushAttachedHostStateOutbox: jest.fn(async () => []),
  queueAttachedHostStateAction: jest.fn(),
  readAttachedHostStateOutbox: jest.fn(() => []),
  readAttachedHost: jest.fn(() => null),
}))

import { App } from "./App"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { CreateSession } from "../hooks/useAgentSession"
import type { TranscriptEntry, TranscriptFs } from "../../agent/transcript"
import type { RunShellOpts, ShellResult } from "../../agent/run-shell"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { UsageInfo } from "../state/types"
import {
  attachLocalHost,
  flushAttachedHostStateOutbox,
  queueAttachedHostStateAction,
} from "../../handoff/host-state-client"
import {
  createEmptyHostStateSession,
  sessionStateChannel,
} from "@cognia/agent-config-types/host-state"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  // The active model is remembered under the active provider (per-provider
  // memory); `model` mirrors it for display. `resolveActiveModel` reads the
  // per-provider slot, so both agree.
  model: "claude-x",
  providers: { anthropic: { model: "claude-x" } },
  cwd: "/work",
}

const sessionData: Record<string, TranscriptEntry[]> = {
  ses1: [
    { ts: 1, role: "user", content: "resumed question" },
    { ts: 2, role: "assistant", content: "resumed answer" },
  ],
}
const transcriptFs: TranscriptFs = {
  append: () => {},
  mkdirp: () => {},
  read: (p) => {
    const id = p.replace(/.*[\\/]/, "").replace(/\.jsonl$/, "")
    const entries = sessionData[id]
    return entries ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n" : null
  },
}

const result = (text: string): RunAndCaptureResult => ({
  text,
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
})

/** A fake session whose send streams a scripted answer. */
function fakeSession(answer = "the answer", usage?: UsageInfo) {
  const closed = jest.fn()
  const prompts: string[] = []
  const create: CreateSession = () => ({
    sessionId: "ses-fake",
    async send(prompt, opts) {
      prompts.push(prompt)
      opts.onEvent?.({ type: "text-delta", delta: answer })
      if (usage) opts.onEvent?.({ type: "usage", usage })
      return result(answer)
    },
    close: closed,
  })
  return { create, closed, prompts }
}

function type(text: string) {
  for (const ch of text) act(() => __fireInput(ch))
}

function submit() {
  act(() => __fireInput("", { return: true }))
}

describe("App", () => {
  beforeEach(() => __resetInk())

  it("persists a submitted line to the durable history store", async () => {
    const { appendHistory } = jest.requireMock("../input/history-store") as {
      appendHistory: jest.Mock
    }
    appendHistory.mockClear()
    const { create } = fakeSession("ok")
    render(<App config={config} sessionId="s1" createSession={create} home="/home/u/.cognia" />)
    type("remember me")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(appendHistory).toHaveBeenCalledWith("/home/u/.cognia", "remember me")
  })

  it("submits a prompt and renders the streamed answer", async () => {
    const { create } = fakeSession("hello there")
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("hello there"))
    expect(container.textContent).toContain("hi")
  })

  it("routes attached sends through the HostState outbox instead of the standalone session", async () => {
    const targetId = "target-remote"
    const sessionId = "session-remote"
    const channel = sessionStateChannel(targetId, sessionId)
    const state = createEmptyHostStateSession(channel, sessionId)
    const queuedAction = {
      channel,
      accountId: "local-default",
      runtimeTargetId: targetId,
      hostId: "host-remote",
      hostGeneration: 2,
      sessionId,
      clientId: "tui-client",
      clientSeq: 1,
      actionId: "tui-action",
      createdAt: 1,
      action: {
        kind: "message.enqueue" as const,
        messageId: "message-remote",
        text: "remote prompt",
        attachments: [],
      },
    }
    jest.mocked(attachLocalHost).mockResolvedValueOnce({
      record: {
        accountId: "local-default",
        runtimeTargetId: targetId,
        hostId: "host-remote",
        hostGeneration: 2,
        sessionId,
        attachedAt: 1,
      },
      client: {} as never,
      snapshot: {
        channel,
        hostId: "host-remote",
        hostGeneration: 2,
        cutHostSeq: 0,
        revision: 0,
        digest: "hsv1-test",
        state,
      },
      subscriptions: [],
    })
    jest.mocked(queueAttachedHostStateAction).mockReturnValueOnce(queuedAction)
    jest
      .mocked(flushAttachedHostStateOutbox)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          action: queuedAction,
          status: "sent",
          receipt: {
            actionId: queuedAction.actionId,
            outcome: "applied",
            hostGeneration: 2,
            hostSeq: 1,
          },
        },
      ])
    const local = fakeSession("must not run")
    render(<App config={config} sessionId="local" createSession={local.create} home="/tmp/tui" />)

    type(`/attach --target ${targetId} --session ${sessionId}`)
    submit()
    await waitFor(() => expect(attachLocalHost).toHaveBeenCalled())
    type("remote prompt")
    submit()
    await waitFor(() => expect(queueAttachedHostStateAction).toHaveBeenCalled())

    expect(local.prompts).toEqual([])
    expect(queueAttachedHostStateAction).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeTargetId: targetId, sessionId }),
      expect.objectContaining({ kind: "message.enqueue", text: "remote prompt" }),
      expect.objectContaining({ home: "/tmp/tui" })
    )
  })

  it("backtracks to edit the last user message on double-Esc then Enter", async () => {
    const { create } = fakeSession("ok")
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("backtrack me please")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("ok"))
    const occurrences = () => (container.textContent ?? "").split("backtrack me please").length - 1
    // After submit the message lives only in the transcript (composer cleared).
    const before = occurrences()
    // First Esc arms; second Esc enters backtrack selection (highlight only).
    act(() => __fireInput("", { escape: true }))
    act(() => __fireInput("", { escape: true }))
    // Enter loads the highlighted message into the composer for editing.
    act(() => __fireInput("", { return: true }))
    expect(occurrences()).toBe(before + 1)
  })

  it("forks the conversation when an edited earlier message is submitted", async () => {
    const { create, prompts } = fakeSession("answer")
    const { container } = render(<App config={config} sessionId="ses1" createSession={create} />)
    // Two turns.
    type("first question")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("first question"))
    type("second question")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("second question"))
    // Backtrack: enter selection, walk up to the FIRST user message, edit it.
    act(() => __fireInput("", { escape: true }))
    act(() => __fireInput("", { escape: true }))
    act(() => __fireInput("", { upArrow: true }))
    act(() => __fireInput("", { return: true }))
    // Edit the loaded text and resubmit → forks at the first user message,
    // discarding the second turn, then sends the edited prompt.
    type(" edited")
    await act(async () => {
      submit()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(prompts[prompts.length - 1]).toContain("edited"))
    // The discarded turn is gone from the transcript after the fork.
    await waitFor(() => expect(container.textContent).not.toContain("second question"))
  })

  it("shows the selection position and discard count, and Esc cancels the edit", async () => {
    const { create } = fakeSession("ok")
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("only question")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("only question"))
    // Enter backtrack selection — the status line shows #1/1.
    act(() => __fireInput("", { escape: true }))
    act(() => __fireInput("", { escape: true }))
    await waitFor(() => expect(container.textContent).toContain("Editing message #1/1"))
    // Commit → editing status shows 0 later turns discarded.
    act(() => __fireInput("", { return: true }))
    await waitFor(() =>
      expect(container.textContent).toContain("0 later turn(s) will be discarded")
    )
    // Esc cancels the edit: status line and loaded text both clear.
    act(() => __fireInput("", { escape: true }))
    await waitFor(() => expect(container.textContent).not.toContain("will be discarded"))
  })

  it("abandons a pending edit when a slash command is submitted instead", async () => {
    const { create } = fakeSession("ok")
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("a question")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("a question"))
    // Backtrack + commit loads the message for editing.
    act(() => __fireInput("", { escape: true }))
    act(() => __fireInput("", { escape: true }))
    act(() => __fireInput("", { return: true }))
    await waitFor(() => expect(container.textContent).toContain("will be discarded"))
    // Clear the loaded text (Ctrl+U) and submit a command instead → edit abandoned.
    act(() => __fireInput("u", { ctrl: true }))
    type("/help")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).not.toContain("will be discarded"))
  })

  it("copies the last assistant reply to the clipboard on Ctrl+P", async () => {
    const { create } = fakeSession("the reply text")
    const copyClipboard = jest.fn(() => Promise.resolve({ ok: true } as const))
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} copyClipboard={copyClipboard} />
    )
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("the reply text"))
    await act(async () => {
      __fireInput("p", { ctrl: true })
      await Promise.resolve()
    })
    expect(copyClipboard).toHaveBeenCalledWith("the reply text")
  })

  it("notes when there is no reply to copy on Ctrl+P", async () => {
    const { create } = fakeSession("ok")
    const copyClipboard = jest.fn(() => Promise.resolve({ ok: true } as const))
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} copyClipboard={copyClipboard} />
    )
    act(() => __fireInput("p", { ctrl: true }))
    await waitFor(() => expect(container.textContent).toContain("No reply to copy yet."))
    expect(copyClipboard).not.toHaveBeenCalled()
  })

  it("clears the screen on Ctrl+L without wiping the conversation", async () => {
    const { create } = fakeSession("kept answer")
    const clearScreen = jest.fn()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} clearScreen={clearScreen} />
    )
    type("kept prompt")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("kept answer"))
    clearScreen.mockClear()
    act(() => __fireInput("l", { ctrl: true }))
    expect(clearScreen).toHaveBeenCalled()
    // The transcript survives — Ctrl+L only repaints, unlike `/clear`.
    expect(container.textContent).toContain("kept answer")
  })

  it("surfaces interrupted background subagent history in the footer", async () => {
    const backgroundTasks = jest.requireMock("../../agent/subagent-background-tasks") as {
      countInterruptedCliBackgroundRuns: jest.Mock
    }
    backgroundTasks.countInterruptedCliBackgroundRuns.mockResolvedValueOnce(2)
    const { create } = fakeSession("idle")
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} home="/tmp/cognia" />
    )

    await waitFor(() => expect(container.textContent ?? "").toContain("! 2 bg interrupted"))
    expect(backgroundTasks.countInterruptedCliBackgroundRuns).toHaveBeenCalledWith({
      home: "/tmp/cognia",
      owner: "s1",
    })
  })

  it("does not poll running background runs on input-only rerenders", () => {
    const backgroundTasks = jest.requireMock("../../agent/subagent-background-tasks") as {
      countRunningCliBackgroundRuns: jest.Mock
    }
    backgroundTasks.countRunningCliBackgroundRuns.mockClear()
    const { create } = fakeSession("idle")
    render(<App config={config} sessionId="s1" createSession={create} home="/tmp/cognia" />)
    backgroundTasks.countRunningCliBackgroundRuns.mockClear()
    type("abc")
    expect(backgroundTasks.countRunningCliBackgroundRuns).not.toHaveBeenCalled()
  })

  it("resolves a @skill mention: enables it and strips the token from the prompt", async () => {
    const { create, prompts } = fakeSession("done")
    const enabled: string[] = []
    const mentionProviders = {
      files: () => [],
      skills: async () => [
        { kind: "skill" as const, id: "skill_cite", label: "Cite", insert: "@skill:skill_cite" },
      ],
      agents: async () => [],
    }
    render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        mentionProviders={mentionProviders}
        persistSkillEnabled={(id) => enabled.push(id)}
      />
    )
    type("@skill:skill_cite explain")
    await act(async () => {
      submit()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(prompts.length).toBe(1))
    // The skill was enabled and its token stripped from what reaches the model.
    expect(enabled).toEqual(["skill_cite"])
    expect(prompts[0]).toBe("explain")
  })

  it("resolves a @agent mention: dispatches it and folds the result into the prompt", async () => {
    const { create, prompts } = fakeSession("done")
    const mentionProviders = {
      files: () => [],
      skills: async () => [],
      agents: async () => [
        {
          kind: "agent" as const,
          id: "code-reviewer",
          label: "code-reviewer",
          insert: "@agent:code-reviewer",
        },
      ],
    }
    render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        mentionProviders={mentionProviders}
      />
    )
    type("@agent:code-reviewer look")
    await act(async () => {
      submit()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // The agent dispatch path hits real discovery (no .cognia/agents → not
    // found), so the prompt carries an error block rather than crashing.
    await waitFor(() => expect(prompts.length).toBe(1))
    expect(prompts[0]).toContain('<agent id="code-reviewer"')
  })

  it("opens the permission overlay on a tool request and unblocks the turn when approved", async () => {
    let approved: unknown = null
    let resolved = false
    const create: CreateSession = () => ({
      sessionId: "ses-perm",
      async send(_prompt, opts) {
        // The dispatcher asks to run a tool; the turn is blocked until the
        // overlay resolves — exactly the real `permission_request` round-trip.
        approved = await opts.gate({
          toolName: "ls",
          displayName: "ls",
          input: { path: "." },
          requestId: "r1",
          sessionId: "s",
        } as never)
        resolved = true
        return result("done")
      },
      close: jest.fn(),
    })
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("go")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // The overlay must appear and the turn stays blocked on it.
    await waitFor(() => expect(container.textContent).toContain("Allow ls"))
    expect(resolved).toBe(false)
    // Enter selects "Allow once" → the gate resolves → the turn proceeds.
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(approved).toEqual({ decision: "allow" }))
    expect(resolved).toBe(true)
  })

  it("closes a pending permission overlay on Ctrl+C interrupt (no lingering prompt)", async () => {
    const create: CreateSession = () => ({
      sessionId: "ses-perm-int",
      async send(_prompt, opts) {
        // Block on the gate forever — the user interrupts before deciding.
        await opts.gate({
          toolName: "ls",
          displayName: "ls",
          input: { path: "." },
          requestId: "r1",
          sessionId: "s",
        } as never)
        return result("done")
      },
      close: jest.fn(),
    })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} now={() => 1000} />
    )
    type("go")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Allow ls"))
    // Ctrl+C while busy + overlay open → interrupt AND dismiss the prompt.
    await act(async () => {
      __fireInput("c", { ctrl: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).not.toContain("Allow ls"))
    expect(container.textContent).toContain("Turn stopped by user")
  })

  it("persists an 'Allow always' choice and invalidates options", async () => {
    const persistToolApproval = jest.fn()
    const invalidate = jest.fn()
    const create: CreateSession = () => ({
      sessionId: "ses-perm2",
      async send(_prompt, opts) {
        await opts.gate({
          toolName: "mcp__cognia-tools__bash",
          displayName: "mcp__cognia-tools__bash",
          input: { command: "ls" },
          requestId: "r1",
          sessionId: "s",
        } as never)
        return result("done")
      },
      invalidateOptions: invalidate,
      close: jest.fn(),
    })
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        persistToolApproval={persistToolApproval}
      />
    )
    type("go")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Allow bash"))
    // Move to "Allow always" (index 1) and select it.
    act(() => __fireInput("", { downArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(persistToolApproval).toHaveBeenCalledWith("/home/u/.cognia", "mcp__cognia-tools__bash")
    )
    expect(invalidate).toHaveBeenCalled()
  })

  it("Ctrl+T expands collapsed tool output", async () => {
    const create: CreateSession = () => ({
      sessionId: "ses-tool",
      async send(_prompt, opts) {
        opts.onEvent?.({ type: "tool-call", toolName: "bash", input: { command: "ls" } })
        opts.onEvent?.({
          type: "tool-result",
          toolName: "bash",
          input: { command: "ls" },
          result: "SENTINEL_TOOL_PREVIEW\nSENTINEL_TOOL_DETAIL",
        })
        return result("done")
      },
      close: jest.fn(),
    })
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("run ls")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Collapsed tools keep one useful preview line without exposing the full body.
    await waitFor(() => expect(container.textContent).toContain("bash"))
    expect(container.textContent).toContain("SENTINEL_TOOL_PREVIEW")
    expect(container.textContent).not.toContain("SENTINEL_TOOL_DETAIL")
    // Ctrl+T reveals all tool output (Ctrl+R now opens history search).
    act(() => __fireInput("t", { ctrl: true }))
    await waitFor(() => expect(container.textContent).toContain("SENTINEL_TOOL_DETAIL"))
  })

  it("runs /clear to reset the transcript and wipe the terminal", async () => {
    const { create } = fakeSession("answer one")
    const clearScreen = jest.fn()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        mintId={() => "ses-2"}
        clearScreen={clearScreen}
      />
    )
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("answer one"))
    type("/clear")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // /clear is destructive → it opens a confirm overlay first. Confirm with Enter.
    await waitFor(() => expect(container.textContent).toContain("Start a fresh session?"))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    // The terminal is wiped (Static scrollback won't clear itself) AND state reset.
    expect(clearScreen).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(container.textContent).not.toContain("answer one"))
  })

  it("runs /handoff and shows a notice", async () => {
    const { create } = fakeSession()
    const pushHandoff = jest.fn().mockResolvedValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} pushHandoff={pushHandoff} />
    )
    type("/handoff")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Pushed this session"))
    expect(pushHandoff).toHaveBeenCalledWith("s1")
  })

  it("reports /handoff failure when the desktop is not reachable", async () => {
    const { create } = fakeSession()
    const pushHandoff = jest.fn().mockResolvedValue(false)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} pushHandoff={pushHandoff} />
    )
    type("/handoff")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("No running Cognia desktop"))
    expect(container.textContent).not.toContain("Pushed this session")
  })

  it("reports an unknown command", async () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/bogus")
    submit()
    await waitFor(() => expect(container.textContent).toContain("Unknown command /bogus"))
  })

  it("notices when /plan refine is run with no plan to refine", async () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/plan refine")
    submit()
    await waitFor(() => expect(container.textContent).toContain("No plan to refine"))
  })

  it("exits on /exit", async () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    render(<App config={config} sessionId="s1" createSession={create} onExit={onExit} />)
    type("/exit")
    submit()
    await waitFor(() => expect(onExit).toHaveBeenCalled())
  })

  it("exits on a double Ctrl+C", async () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    render(
      <App config={config} sessionId="s1" createSession={create} onExit={onExit} now={() => 5000} />
    )
    // Real terminals can deliver both bytes before React commits the first
    // CTRL_C state update; the synchronous guard must still exit on press two.
    act(() => {
      __fireInput("c", { ctrl: true })
      __fireInput("c", { ctrl: true })
    })
    await waitFor(() => expect(onExit).toHaveBeenCalled())
  })

  it("does not exit on a single Ctrl+C", () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    let t = 0
    render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        onExit={onExit}
        now={() => (t += 5000)}
      />
    )
    act(() => __fireInput("c", { ctrl: true }))
    expect(onExit).not.toHaveBeenCalled()
  })

  it("shows an exit hint notice on the first Ctrl+C when idle", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} now={() => 1000} />
    )
    act(() => __fireInput("c", { ctrl: true }))
    expect(container.textContent).toContain("Press Ctrl+C again to exit")
  })

  it.each([
    ["Ctrl+C", () => __fireInput("c", { ctrl: true })],
    ["Esc", () => __fireInput("", { escape: true })],
  ])("%s aborts the actual in-flight turn signal", async (_label, interrupt) => {
    let capturedSignal: AbortSignal | undefined
    const create: CreateSession = () => ({
      sessionId: "ses-blocking",
      send: jest.fn(
        (_prompt, opts) =>
          new Promise<RunAndCaptureResult>((_resolve, reject) => {
            capturedSignal = opts.signal
            opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            })
          })
      ),
      close: jest.fn(async () => undefined),
    })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} now={() => 1000} />
    )
    type("keep running")
    submit()
    await waitFor(() => expect(capturedSignal).toBeDefined())

    if (_label === "Ctrl+C") type("queued draft")
    act(interrupt)

    await waitFor(() => expect(capturedSignal?.aborted).toBe(true))
    await waitFor(() => expect(container.textContent).toContain("Turn stopped by user"))
  })

  it("clears the composer draft on the first Ctrl+C instead of arming the exit ladder", () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    let t = 1000
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} onExit={onExit} now={() => t} />
    )
    act(() => __fireInput("x"))
    act(() => __fireInput("y"))
    act(() => __fireInput("z"))
    expect(container.textContent).toContain("xyz")
    // First Ctrl+C with draft text clears it — no exit hint, no exit.
    act(() => __fireInput("c", { ctrl: true }))
    expect(container.textContent).not.toContain("xyz")
    expect(container.textContent).not.toContain("Press Ctrl+C again to exit")
    expect(onExit).not.toHaveBeenCalled()
    // With the composer now empty, the next Ctrl+C arms the exit hint as usual.
    t = 9000
    act(() => __fireInput("c", { ctrl: true }))
    expect(container.textContent).toContain("Press Ctrl+C again to exit")
    expect(onExit).not.toHaveBeenCalled()
  })

  it("exits on a second Ctrl+C within the 1s double-press window", async () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    let t = 1000
    render(
      <App config={config} sessionId="s1" createSession={create} onExit={onExit} now={() => t} />
    )
    // First press at t=1000.
    act(() => __fireInput("c", { ctrl: true }))
    // Second press at t=1500 — within the 1s window.
    t = 1500
    act(() => __fireInput("c", { ctrl: true }))
    await waitFor(() => expect(onExit).toHaveBeenCalled())
  })

  it("completes a double-Ctrl+C exit without waiting for live-session cleanup", async () => {
    let releaseClose: (() => void) | undefined
    const close = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve
        })
    )
    const create: CreateSession = () => ({
      sessionId: "ses-live",
      async send() {
        return result("ok")
      },
      close,
    })
    const onExit = jest.fn()
    let t = 1000
    render(
      <App config={config} sessionId="s1" createSession={create} onExit={onExit} now={() => t} />
    )
    type("start sidecar")
    submit()
    await waitFor(() => expect(close).not.toHaveBeenCalled())

    act(() => __fireInput("c", { ctrl: true }))
    t = 1500
    act(() => __fireInput("c", { ctrl: true }))

    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(onExit).toHaveBeenCalledTimes(1)
    releaseClose?.()
  })

  it("opens the help overlay on /help", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/help")
    submit()
    expect(container.textContent).toContain("Commands")
  })

  it("opens the usage panel on /usage", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/usage")
    submit()
    expect(container.textContent).toContain("Usage")
  })

  it("opens and applies the model switcher on /model", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/model")
    submit()
    expect(container.textContent).toContain("Switch model")
    act(() => __fireInput("", { return: true })) // select the only model
    expect(container.textContent).not.toContain("Switch model")
  })

  it("opens the mode switcher on /mode", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    // Trailing space closes the palette (`/mode` also prefix-matches `/model`).
    type("/mode ")
    submit()
    expect(container.textContent).toContain("Permission mode")
    expect(container.textContent).toContain("plan")
  })

  it("notes when no models are configured", () => {
    const { create } = fakeSession()
    // A provider with no shared catalog and no configured model → empty list.
    const bare: ResolvedConfig = {
      ...DEFAULT_RESOLVED_CONFIG,
      provider: "uncatalogued",
      cwd: "/work",
    }
    const { container } = render(<App config={bare} sessionId="s1" createSession={create} />)
    type("/model")
    submit()
    expect(container.textContent).toContain("No models configured")
  })

  it("browses and resumes a past session on /sessions", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => ["ses1.jsonl"]}
        transcriptFs={transcriptFs}
      />
    )
    type("/sessions")
    submit()
    expect(container.textContent).toContain("Resume session")
    expect(container.textContent).toContain("resumed question")
    await act(async () => {
      __fireInput("", { return: true }) // resume the highlighted session
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("resumed answer"))
  })

  it("cycles the permission mode on Shift+Tab", async () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    act(() => __fireInput("", { tab: true, shift: true }))
    // default → acceptEdits (first step of the PERMISSION_MODES cycle).
    expect(container.textContent).toContain("Permission mode: acceptEdits")
  })

  it("opens the session picker on /resume", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => ["ses1.jsonl"]}
        transcriptFs={transcriptFs}
      />
    )
    type("/resume")
    submit()
    // /resume now opens the selection panel (like /sessions) rather than
    // jumping straight into the most recent session.
    expect(container.textContent).toContain("Resume session")
    expect(container.textContent).toContain("resumed question")
    await act(async () => {
      __fireInput("", { return: true }) // resume the highlighted session
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("resumed answer"))
  })

  it("resumes the most recent session directly on /continue", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => ["ses1.jsonl"]}
        transcriptFs={transcriptFs}
      />
    )
    type("/continue")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("resumed answer"))
  })

  it("notices when there is nothing to resume on /continue", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} home="/home" readdir={() => []} />
    )
    type("/continue")
    submit()
    expect(container.textContent).toContain("No past sessions to resume.")
  })

  it("resumes a specific session on /resume <id> and notices on an unknown id", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => ["ses1.jsonl"]}
        transcriptFs={transcriptFs}
      />
    )
    type("/resume nope")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('No session "nope"')
    type("/resume ses1")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("resumed answer"))
  })

  it("runs the launch-flag initial command once on mount (--continue)", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => ["ses1.jsonl"]}
        transcriptFs={transcriptFs}
        initialCommand="/continue"
      />
    )
    await waitFor(() => expect(container.textContent).toContain("resumed answer"))
  })

  it("recalls the previous submission with the up arrow", async () => {
    const { create, prompts } = fakeSession("ok")
    render(<App config={config} sessionId="s1" createSession={create} />)
    type("alpha")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Composer is empty again; ↑ recalls "alpha", Enter re-sends it.
    act(() => __fireInput("", { upArrow: true }))
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(prompts).toEqual(["alpha", "alpha"])
  })

  it("re-sends the last message on /retry", async () => {
    const { create, prompts } = fakeSession("ok")
    render(<App config={config} sessionId="s1" createSession={create} />)
    type("first question")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    type("/retry")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(prompts).toEqual(["first question", "first question"])
  })

  it("copies the last reply on /copy", async () => {
    const { create } = fakeSession("the reply text")
    const copyClipboard = jest.fn().mockResolvedValue({ ok: true })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} copyClipboard={copyClipboard} />
    )
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    type("/copy")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(copyClipboard).toHaveBeenCalledWith("the reply text")
    await waitFor(() => expect(container.textContent).toContain("Copied the last reply"))
  })

  it("shows the too-large notice when /copy is refused by the OSC 52 cap", async () => {
    const { create } = fakeSession("the reply text")
    const copyClipboard = jest.fn().mockResolvedValue({ ok: false, reason: "too-large" })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} copyClipboard={copyClipboard} />
    )
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    type("/copy")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("too large to copy over OSC 52"))
  })

  it("honors a config-overridden clipboard notice", async () => {
    const { create } = fakeSession("the reply text")
    const copyClipboard = jest.fn().mockResolvedValue({ ok: false, reason: "unavailable" })
    const { container } = render(
      <App
        config={{ ...config, notices: { clipboardUnavailable: "CLIP-OVERRIDE" } }}
        sessionId="s1"
        createSession={create}
        copyClipboard={copyClipboard}
      />
    )
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    type("/copy")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("CLIP-OVERRIDE"))
  })

  it("shows the working directory on /cwd", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/cwd")
    submit()
    expect(container.textContent).toContain("/work")
  })

  it("lists enabled built-in tools on /tools", () => {
    const { create } = fakeSession()
    const withTools: ResolvedConfig = {
      ...config,
      builtinTools: { ...config.builtinTools, git: true },
    }
    const { container } = render(<App config={withTools} sessionId="s1" createSession={create} />)
    type("/tools")
    submit()
    expect(container.textContent).toContain("git")
  })

  it("shows version + provider on /about", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/about")
    submit()
    expect(container.textContent).toContain("cognia-agent v")
    expect(container.textContent).toContain("anthropic")
  })

  it("renders streamed usage in the footer", async () => {
    const { create } = fakeSession("done", {
      inputTokens: 1000,
      outputTokens: 200,
      totalCostUsd: 0.5,
    })
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Cost is accumulated from the streamed `usage` event, not left at $0.00.
    await waitFor(() => expect(container.textContent).toContain("$0.50"))
    expect(container.textContent).toContain("1.2k tok")
  })

  it("sizes context % to the catalog window and prices $0 turns from pricing", async () => {
    // ai-sdk path: streamed usage has 100k prompt tokens but no totalCostUsd.
    const { create } = fakeSession("done", { inputTokens: 100_000, outputTokens: 0 })
    const resolveMeta = jest.fn(async () => ({
      modelId: "claude-x",
      contextWindow: 1_000_000,
      pricing: { promptPer1M: 3, completionPer1M: 15 },
    }))
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} resolveMeta={resolveMeta} />
    )
    // Let the model-meta effect land before the turn so SET_USAGE can price it.
    await act(async () => {
      await Promise.resolve()
    })
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // 100k / 1M window = 10% (not 50% of the 200k fallback).
    await waitFor(() => expect(container.textContent).toContain("10% ctx"))
    // Cost estimated from catalog pricing: 100k × $3/1M = $0.30 (not $0.00).
    expect(container.textContent).toContain("$0.30")
    expect(resolveMeta).toHaveBeenCalledWith("anthropic", "claude-x")
  })

  it("opens the settings panel on /config", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={() => true} />
    )
    type("/config")
    submit()
    expect(container.textContent).toContain("Settings")
    expect(container.textContent).toContain("Provider")
    expect(container.textContent).toContain("Permission mode")
  })

  it("prompts for a key (without switching) when the picked provider has no credential", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={persistConfig} />
    )
    type("/provider")
    submit()
    expect(container.textContent).toContain("Switch provider")
    // anthropic is active + first; move down once to "openai" and select it.
    act(() => __fireInput("", { downArrow: true }))
    act(() => __fireInput("", { return: true }))
    // A key-required provider with no credential opens the inline key prompt —
    // the session is NOT switched until the key is entered.
    expect(container.textContent).toContain("Add API key for OpenAI")
    expect(persistConfig).not.toHaveBeenCalledWith("provider", "openai")
  })

  it("opens masked credential management for an already-configured provider", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistCredential = jest.fn().mockReturnValue(true)
    const configured: ResolvedConfig = {
      ...config,
      provider: "deepseek",
      model: "deepseek-chat",
      providers: { deepseek: { apiKey: "sk-existing", model: "deepseek-chat" } },
    }
    const { container } = render(
      <App
        config={configured}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistCredential={persistCredential}
      />
    )

    type("/provider")
    submit()
    act(() => __fireInput("", { return: true }))

    expect(container.textContent).toContain("Manage API key for DeepSeek")
    expect(container.textContent).not.toContain("sk-existing")
    act(() => __fireInput("r", { ctrl: true }))
    expect(container.textContent).toContain("sk-existing")

    act(() => __fireInput("u", { ctrl: true }))
    type("sk-replacement")
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistCredential).toHaveBeenCalledWith("deepseek", "sk-replacement", "apiKey")
    expect(persistConfig).toHaveBeenCalledWith("provider", "deepseek")
  })

  it("returns from credential management to the provider picker on Escape", () => {
    const { create } = fakeSession()
    const configured: ResolvedConfig = {
      ...config,
      provider: "deepseek",
      providers: { deepseek: { apiKey: "sk-existing" } },
    }
    const { container } = render(<App config={configured} sessionId="s1" createSession={create} />)

    type("/provider")
    submit()
    act(() => __fireInput("", { return: true }))
    expect(container.textContent).toContain("Manage API key for DeepSeek")
    act(() => __fireInput("", { escape: true }))
    expect(container.textContent).toContain("Switch provider")
  })

  it("saves the entered key and switches to the provider", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistCredential = jest.fn().mockReturnValue(true)
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistCredential={persistCredential}
      />
    )
    type("/provider")
    submit()
    act(() => __fireInput("", { downArrow: true })) // → openai
    act(() => __fireInput("", { return: true })) // opens the key prompt
    expect(container.textContent).toContain("Add API key for OpenAI")
    // The typed key is masked in the prompt, never echoed in the clear.
    type("sk-test-123")
    expect(container.textContent).not.toContain("sk-test-123")
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistCredential).toHaveBeenCalledWith("openai", "sk-test-123", "apiKey")
    expect(persistConfig).toHaveBeenCalledWith("provider", "openai")
    await waitFor(() => expect(container.textContent).toContain("Saved API key and switched"))
  })

  it("surfaces a failure to save the key on the prompt (no switch)", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistCredential = jest.fn().mockReturnValue(false)
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistCredential={persistCredential}
      />
    )
    type("/provider")
    submit()
    act(() => __fireInput("", { downArrow: true }))
    act(() => __fireInput("", { return: true }))
    type("sk-bad")
    act(() => __fireInput("", { return: true }))
    expect(container.textContent).toContain("Couldn't save the key")
    expect(persistConfig).not.toHaveBeenCalledWith("provider", "openai")
  })

  it("filters the provider picker by typeahead and switches a key-less provider directly", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={persistConfig} />
    )
    type("/provider")
    submit()
    // Narrow the shared catalog to Ollama by typing into the search row, then
    // select it: a key-less provider switches straight away — no key prompt.
    type("ollama")
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("provider", "ollama")
    expect(container.textContent).not.toContain("Add API key")
  })

  it("sets + persists the thinking level on /think (warns on a non-reasoning model)", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistPluginTools = jest.fn()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistPluginTools={persistPluginTools}
      />
    )
    type("/think")
    submit()
    expect(container.textContent).toContain("Reasoning effort")
    // Seeded off (no level set) at slider index 0. Tab to the slider, then move
    // right twice (low → medium → high), clearing off, and confirm.
    act(() => __fireInput("", { tab: true }))
    act(() => __fireInput("", { rightArrow: true }))
    act(() => __fireInput("", { rightArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("thinkingLevel", "high")
    // Not ultracode → the dynamic-workflow gate is persisted off.
    expect(persistPluginTools).toHaveBeenCalledWith(expect.any(String), false)
    // claude-x isn't a reasoning model → the level is saved with a warning.
    await waitFor(() => expect(container.textContent).toContain("doesn't support thinking levels"))
  })

  it("sets the thinking level without a warning on a reasoning-capable model", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistPluginTools = jest.fn()
    const { container } = render(
      <App
        // Override BOTH the top-level model and the provider model: the active
        // model is resolved from the provider entry, so a reasoning-capable id
        // must be set there too (the base fixture pins "claude-x").
        config={{
          ...config,
          model: "claude-opus-4-8",
          providers: { anthropic: { model: "claude-opus-4-8" } },
        }}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistPluginTools={persistPluginTools}
      />
    )
    type("/effort")
    submit()
    // Seeded off at slider index 0 (low). Tab to the slider, left clears off and
    // clamps at low, then confirm → "low".
    act(() => __fireInput("", { tab: true }))
    act(() => __fireInput("", { leftArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("thinkingLevel", "low")
    expect(container.textContent).not.toContain("doesn't support thinking levels")
  })

  it("selecting ultracode persists the level and enables the dynamic-workflow gate", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistPluginTools = jest.fn()
    render(
      <App
        config={{ ...config, model: "claude-opus-4-8" }}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistPluginTools={persistPluginTools}
      />
    )
    type("/effort")
    submit()
    // Tab to the slider, then move right to the top tier (low→…→ultracode = 5 ticks).
    act(() => __fireInput("", { tab: true }))
    for (let i = 0; i < 6; i++) act(() => __fireInput("", { rightArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("thinkingLevel", "ultracode")
    expect(persistPluginTools).toHaveBeenCalledWith(expect.any(String), true)
  })

  it("drills from the settings panel into the provider switcher", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={() => true} />
    )
    type("/config")
    submit()
    // First row is Provider; Enter opens the provider switcher.
    act(() => __fireInput("", { return: true }))
    expect(container.textContent).toContain("Switch provider")
  })

  it("returns to settings after switching providers and can edit the active credential", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistCredential = jest.fn().mockReturnValue(true)
    const configured: ResolvedConfig = {
      ...config,
      providers: {
        anthropic: { apiKey: "sk-ant", model: "claude-x" },
        openai: { apiKey: "sk-openai" },
      },
    }
    const { container } = render(
      <App
        config={configured}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistCredential={persistCredential}
      />
    )

    type("/settings")
    submit()
    act(() => __fireInput("", { return: true }))
    act(() => __fireInput("", { downArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })

    expect(container.textContent).toContain("Manage API key for OpenAI")
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })

    expect(container.textContent).toContain("Settings")
    expect(container.textContent).toContain("openai")
    expect(container.textContent).toContain("Credential")

    act(() => __fireInput("", { downArrow: true }))
    act(() => __fireInput("", { return: true }))
    expect(container.textContent).toContain("Manage API key for OpenAI")

    act(() => __fireInput("u", { ctrl: true }))
    type("sk-replacement")
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistCredential).toHaveBeenCalledWith("openai", "sk-replacement", "apiKey")
    expect(container.textContent).toContain("Settings")
    expect(container.textContent).toContain("API key configured")
  })

  it("opens an auth-token credential from settings without exposing it", () => {
    const { create } = fakeSession()
    const configured: ResolvedConfig = {
      ...config,
      provider: "anthropic",
      providers: { anthropic: { authToken: "token-existing", model: "claude-x" } },
    }
    const { container } = render(
      <App config={configured} sessionId="s1" createSession={create} persistConfig={() => true} />
    )

    type("/settings")
    submit()
    act(() => __fireInput("", { downArrow: true }))
    act(() => __fireInput("", { return: true }))

    expect(container.textContent).toContain("Manage token for Anthropic")
    expect(container.textContent).not.toContain("token-existing")
  })

  it("routes /goal with no objective to a usage notice", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistDb={() => {}} />
    )
    type("/goal")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Usage: /goal"))
  })

  it("routes /mcp to the no-servers notice when none are configured", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistDb={() => {}}
        home="/nonexistent-home"
      />
    )
    type("/mcp")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("No MCP servers"))
  })

  it("runs a !command shell-out and shows the output", async () => {
    const { create } = fakeSession()
    const runShell = jest.fn().mockResolvedValue({ stdout: "file-a\nfile-b", stderr: "", code: 0 })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} runShell={runShell} />
    )
    type("!ls")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(runShell).toHaveBeenCalledWith(
      "ls",
      expect.objectContaining({ cwd: "/work", onChunk: expect.any(Function) })
    )
    await waitFor(() => expect(container.textContent).toContain("file-a"))
  })

  it("Ctrl+C kills a blocking foreground !command (abort signal fires)", async () => {
    const { create } = fakeSession()
    // A blocking command that only resolves once its abort signal fires — the
    // dev-server case the fix targets.
    const runShell = jest.fn(
      (_cmd: string, opts: RunShellOpts): Promise<ShellResult> =>
        new Promise((resolve) => {
          opts.signal?.addEventListener("abort", () =>
            resolve({ stdout: "", stderr: "", code: 130, aborted: true })
          )
        })
    )
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} runShell={runShell} />
    )
    type("!sleep 100")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // runShell received an abort signal it can be killed through.
    expect(runShell).toHaveBeenCalledWith(
      "sleep 100",
      expect.objectContaining({ signal: expect.anything() })
    )
    // A single Ctrl+C (empty composer) kills it — no double-press exit needed.
    await act(async () => {
      __fireInput("c", { ctrl: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Command interrupted"))
    await waitFor(() => expect(container.textContent).toContain("[interrupted]"))
  })

  it("Ctrl+B moves a running foreground !command to the background", async () => {
    const { create } = fakeSession()
    // Never resolves: stays "running" so we can observe the background label.
    const runShell = jest.fn((): Promise<ShellResult> => new Promise(() => {}))
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} runShell={runShell} />
    )
    type("!npm run dev")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await act(async () => {
      __fireInput("b", { ctrl: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Command moved to background"))
    await waitFor(() => expect(container.textContent).toContain("(background)"))
  })

  it("routes a plain line into a line-oriented foreground !command's stdin", async () => {
    const { create, prompts } = fakeSession()
    const writes: string[] = []
    // A never-resolving captured command that exposes a stdin writer.
    const runShell = jest.fn((_cmd: string, opts: RunShellOpts): Promise<ShellResult> => {
      opts.registerInput?.((d) => writes.push(d))
      return new Promise(() => {})
    })
    render(<App config={config} sessionId="s1" createSession={create} runShell={runShell} />)
    type("!read answer")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // A subsequent plain line is fed to the command's stdin, not sent to the model.
    type("my-passphrase")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(writes).toEqual(["my-passphrase\n"])
    expect(prompts).toHaveLength(0)
  })

  it("suspends Ink and gives a full-screen !command the inherited terminal", async () => {
    const { create } = fakeSession()
    const runShell = jest.fn().mockResolvedValue({ stdout: "wrong runner", stderr: "", code: 0 })
    const runInteractiveShell = jest.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 })
    let resumeTerminal: (() => Promise<void>) | undefined
    __suspendTerminal.mockImplementationOnce(
      (callback) =>
        new Promise<void>((resolve) => {
          resumeTerminal = async () => {
            await callback?.()
            resolve()
          }
        })
    )
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        runShell={runShell}
        runInteractiveShell={runInteractiveShell}
      />
    )

    type("!top")
    await act(async () => {
      submit()
      await Promise.resolve()
    })

    expect(runShell).not.toHaveBeenCalled()
    expect(__suspendTerminal).toHaveBeenCalledTimes(1)
    expect(runInteractiveShell).not.toHaveBeenCalled()

    await act(async () => {
      await resumeTerminal?.()
    })

    expect(runInteractiveShell).toHaveBeenCalledWith(
      "top",
      expect.objectContaining({ cwd: "/work", signal: expect.anything() })
    )
    await waitFor(() => expect(container.textContent).toContain("Interactive terminal opened"))
  })

  it("/analyze sends the last failed !command to the agent", async () => {
    const { create, prompts } = fakeSession("looking into it")
    const runShell = jest.fn().mockResolvedValue({ stdout: "", stderr: "boom", code: 1 })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} runShell={runShell} />
    )
    type("!false")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // A failed foreground command surfaces the /analyze hint.
    await waitFor(() => expect(container.textContent).toContain("/analyze"))
    type("/analyze")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(prompts.some((p) => p.includes("boom") && p.includes("false"))).toBe(true)
    )
  })

  it("/analyze with no failed command shows a notice", async () => {
    const { create, prompts } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/analyze")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("No failed command to analyze"))
    expect(prompts).toHaveLength(0)
  })

  it("/diff shells git diff and opens the changes in the pager", async () => {
    const { create } = fakeSession()
    const runShell = jest.fn().mockResolvedValue({
      stdout: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new",
      stderr: "",
      code: 0,
    })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} runShell={runShell} />
    )
    type("/diff")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(runShell).toHaveBeenCalledWith("git --no-pager diff", { cwd: "/work" })
    await waitFor(() => expect(container.textContent).toContain("Working tree changes"))
  })

  it("/diff reports a clean tree when there are no changes", async () => {
    const { create } = fakeSession()
    const runShell = jest.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} runShell={runShell} />
    )
    type("/diff")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Working tree clean"))
  })

  it("rings the terminal bell when a long turn finishes (notify on)", async () => {
    // A deferred session so busy commits `true` before the turn completes —
    // otherwise the synchronous fakeSession toggles busy within one commit and
    // the busy→idle transition (which the bell hooks) is never observed.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const send: ReturnType<CreateSession>["send"] = jest.fn(async (_prompt, opts) => {
      opts.onEvent?.({ type: "text-delta", delta: "hi" })
      await gate
      return result("hi")
    })
    const create: CreateSession = () => ({
      sessionId: "ses-gate",
      send,
      close: jest.fn(),
    })
    const titleOut = { isTTY: true, write: jest.fn() }
    let t = 0
    const now = jest.fn(() => (t += 100000))
    render(
      <App
        config={{ ...config, notify: true, terminalTitle: false }}
        sessionId="s1"
        createSession={create}
        titleOut={titleOut}
        titleEnv={{ TERM: "xterm-256color" }}
        now={now}
      />
    )
    type("hello")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Wait until the async turn actually starts. Backend initialization can
    // add awaits before `send`, and releasing earlier would batch TURN_START
    // with TURN_COMMIT so the duration gate never observes the busy edge.
    await waitFor(() => {
      expect(send).toHaveBeenCalled()
      expect(now).toHaveBeenCalled()
    })
    release()
    await waitFor(() => expect(now.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 1000,
    })
    expect(titleOut.write).toHaveBeenCalledWith("\x07")
  })

  it("does not ring the bell when notify is off", async () => {
    const { create } = fakeSession()
    const titleOut = { isTTY: true, write: jest.fn() }
    let t = 0
    render(
      <App
        config={{ ...config, notify: false, terminalTitle: false }}
        sessionId="s1"
        createSession={create}
        titleOut={titleOut}
        now={() => (t += 100000)}
      />
    )
    type("hello")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(titleOut.write).not.toHaveBeenCalledWith("\x07")
  })

  it("lists the Cognia runtime commands in /help", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/help")
    submit()
    expect(container.textContent).toContain("Cognia")
    expect(container.textContent).toContain("/goal")
    expect(container.textContent).toContain("/workflow")
  })

  it("notes when there are no sessions to browse", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => []}
        transcriptFs={transcriptFs}
      />
    )
    type("/sessions")
    submit()
    expect(container.textContent).toContain("No past sessions")
  })

  it("applies + persists a status-bar theme on /statusbar theme", async () => {
    const { create } = fakeSession()
    const persistStatusBar = jest.fn()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        persistStatusBar={persistStatusBar}
      />
    )
    type("/statusbar theme dim")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(persistStatusBar).toHaveBeenCalledWith("/home/u/.cognia", { theme: "dim" })
    // The footer re-rendered with the dim theme (model now dimmed/gray, still shown).
    expect(container.textContent).toContain("claude-x")
  })

  it("opens the full customization picker on a bare /statusbar", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/statusbar")
    submit()
    expect(container.textContent).toContain("Customize status bar")
  })

  it("captures a `# fact` line to memory instead of sending it to the model", async () => {
    const { create, prompts } = fakeSession()
    render(<App config={config} sessionId="s1" createSession={create} home="/home/u/.cognia" />)
    type("# always use pnpm")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // The fact never reached the model (it routed to /remember).
    expect(prompts).not.toContain("always use pnpm")
    expect(prompts.some((p) => p.includes("always use pnpm"))).toBe(false)
  })

  it("opens a file in the editor on /open <path>", async () => {
    const { create } = fakeSession()
    const openInEditorFn = jest.fn().mockResolvedValue(true)
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        openInEditorFn={openInEditorFn}
      />
    )
    type("/open src/a.ts:12")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(openInEditorFn).toHaveBeenCalledWith(
      expect.stringContaining("a.ts"),
      expect.objectContaining({ line: 12 })
    )
    expect(container.textContent).toContain("Opened src/a.ts")
  })

  it("persists the preferred editor on /editor <command>", async () => {
    const { create } = fakeSession()
    const persistEditor = jest.fn()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        persistEditor={persistEditor}
      />
    )
    type("/editor cursor")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(persistEditor).toHaveBeenCalledWith("/home/u/.cognia", { command: "cursor" })
    expect(container.textContent).toContain("Editor: cursor")
  })

  it("reports editor context on a bare /editor", async () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/editor")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(container.textContent).toContain("Editor:")
    expect(container.textContent).toContain("Clickable paths")
  })

  it("switches + persists the colour theme on /theme and repaints the scrollback", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const clearScreen = jest.fn()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        clearScreen={clearScreen}
      />
    )
    clearScreen.mockClear()
    type("/theme dark")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("theme", "dark")
    expect(container.textContent).toContain("Theme: dark")
    // The committed transcript lives in `<Static>`; a theme switch clears + reprints
    // it so the whole history recolours (not just new cells).
    expect(clearScreen).toHaveBeenCalled()
  })

  it("repaints the scrollback when the theme is cycled from the settings panel", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-settings-theme-"))
    try {
      const { create } = fakeSession()
      const clearScreen = jest.fn()
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          persistConfig={() => true}
          clearScreen={clearScreen}
          home={homeDir}
        />
      )
      type("/config")
      submit()
      expect(container.textContent).toContain("Settings")
      clearScreen.mockClear()
      // Tab into "Appearance" (section 1, row 0 = Theme enum), then →/right to
      // cycle it — which recolours the palette and must reprint the `<Static>`
      // transcript, exactly like the `/theme` command path.
      act(() => __fireInput("", { tab: true }))
      await act(async () => {
        __fireInput("", { rightArrow: true })
        await Promise.resolve()
      })
      expect(clearScreen).toHaveBeenCalled()
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it("switches theme via the picker overlay", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={persistConfig} />
    )
    type("/theme")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Move down to "dark" (index 1) and select it.
    act(() => __fireInput("", { downArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("theme", "dark")
  })

  it("keeps the colour theme after sending a turn", async () => {
    const { create } = fakeSession("the answer")
    const persistConfig = jest.fn().mockReturnValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={persistConfig} />
    )
    type("/theme dark")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    persistConfig.mockClear()
    type("hello")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("the answer"))
    // Theme stayed dark: no second theme write happened, and the persisted config
    // key did not get clobbered back to classic.
    expect(persistConfig).not.toHaveBeenCalledWith("theme", expect.any(String))
  })

  it("opens the status panel on /status", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistDb={() => {}}
        home="/nonexistent-home"
      />
    )
    // Trailing space closes the palette (`/status` also prefix-matches `/statusbar`).
    type("/status ")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Status · cognia-agent"))
    expect(container.textContent).toContain("anthropic")
  })

  it("routes /loop to the streaming loop runner and queues a btw steer during the run", async () => {
    let loopDeps: Record<string, unknown> | undefined
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const startLoopRun = jest.fn(async (deps: Record<string, unknown>) => {
      loopDeps = deps
      await gate // keep the run active so runtimeAbort stays set
      ;(deps.dispatch as (a: unknown) => void)({
        type: "ACTIVITY_END",
        status: "done",
        summary: "Loop done.",
      })
    })
    const { create, prompts } = fakeSession("ok")
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        startLoopRun={startLoopRun as never}
      />
    )
    type("/loop 5m hello --n 2")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(startLoopRun).toHaveBeenCalledTimes(1))
    expect(loopDeps).toMatchObject({
      mode: "interval",
      prompt: "hello",
      intervalMs: 5 * 60_000,
      maxIterations: 2,
      sessionId: "s1",
    })

    // A message typed while the loop runs becomes a queued `btw` steer, not a send.
    type("check the logs")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(prompts).not.toContain("check the logs")
    await waitFor(() => expect(container.textContent).toContain("btw×1"))

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Loop done."))
  })

  it("routes /goal to the streaming goal runner with the objective", async () => {
    const startGoalRun = jest.fn(async (objective: string, deps: Record<string, unknown>) => {
      ;(deps.dispatch as (a: unknown) => void)({
        type: "ACTIVITY_END",
        status: "done",
        summary: `did: ${objective}`,
      })
    })
    const { create } = fakeSession("ok")
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        startGoalRun={startGoalRun as never}
      />
    )
    type("/goal ship the release")
    await act(async () => {
      submit()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(startGoalRun).toHaveBeenCalledWith(
        "ship the release",
        expect.objectContaining({ sessionId: "s1" })
      )
    )
    await waitFor(() => expect(container.textContent).toContain("did: ship the release"))
  })

  describe("plan mode", () => {
    const planConfig: ResolvedConfig = { ...config, permissionMode: "plan" }

    it("captures a plan-mode plan, persists it, and opens the approval prompt", async () => {
      const persistPlan = jest.fn(() => "/home/.cognia/plans/s1-plan-2.md")
      const { create } = fakeSession("# Plan\n- step one\n- step two")
      const { container } = render(
        <App
          config={planConfig}
          sessionId="s1"
          createSession={create}
          home="/home/.cognia"
          persistPlan={persistPlan}
        />
      )
      type("design it")
      await act(async () => {
        submit()
        await Promise.resolve()
      })
      await waitFor(() => expect(persistPlan).toHaveBeenCalled())
      expect(container.textContent).toContain("Plan ready for review") // the plan cell header
      expect(container.textContent).toContain("Ready to code?") // the approval overlay
      expect(container.textContent).toContain("/home/.cognia/plans/s1-plan-2.md")
      // The latest plan stays visible as a footer chip (open it with /plan).
      expect(container.textContent).toContain("📋")
    })

    it("approving the plan injects the proceed turn", async () => {
      const persistPlan = jest.fn(() => "/p.md")
      const { create, prompts } = fakeSession("## Approach\n1. a\n2. b")
      render(
        <App
          config={planConfig}
          sessionId="s1"
          createSession={create}
          home="/home/.cognia"
          persistPlan={persistPlan}
        />
      )
      type("plan it")
      await act(async () => {
        submit()
        await Promise.resolve()
      })
      await waitFor(() => expect(persistPlan).toHaveBeenCalled())
      // Enter at index 0 = approve.
      await act(async () => {
        __fireInput("", { return: true })
        await Promise.resolve()
      })
      const { PLAN_APPROVED_PROMPT } = jest.requireActual("../runtime/plan") as {
        PLAN_APPROVED_PROMPT: string
      }
      await waitFor(() => expect(prompts).toContain(PLAN_APPROVED_PROMPT))
    })

    it("does not prompt for a short clarifying reply in plan mode", async () => {
      const persistPlan = jest.fn(() => "/p.md")
      const { create } = fakeSession("Which file first?")
      const { container } = render(
        <App
          config={planConfig}
          sessionId="s1"
          createSession={create}
          home="/home/.cognia"
          persistPlan={persistPlan}
        />
      )
      type("ask me")
      await act(async () => {
        submit()
        await Promise.resolve()
      })
      expect(persistPlan).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain("Plan ready for review")
    })
  })

  // ── Startup onboarding (banner + trust gate) ───────────────────────────────
  describe("startup phase", () => {
    it("shows the welcome banner + trust gate when the folder is untrusted", () => {
      const { create } = fakeSession()
      const { container } = render(
        <App config={config} sessionId="s1" createSession={create} trusted={false} />
      )
      const text = container.textContent ?? ""
      expect(text).toContain("Cognia Agent")
      expect(text).toContain("Do you trust the files")
      expect(text).toContain("Yes, proceed")
    })

    it("trusts the folder and enters chat on 'Yes, proceed'", () => {
      const { create } = fakeSession()
      const trustFolderFn = jest.fn()
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          trusted={false}
          home="/home/u/.cognia"
          trustFolderFn={trustFolderFn}
        />
      )
      act(() => __fireInput("", { return: true }))
      expect(trustFolderFn).toHaveBeenCalledWith("/home/u/.cognia", "/work")
      expect(container.textContent ?? "").not.toContain("Do you trust the files")
    })

    it("switches the working directory from the startup folder picker", () => {
      const { create } = fakeSession()
      const trustFolderFn = jest.fn()
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          trusted={false}
          home="/home/u/.cognia"
          trustFolderFn={trustFolderFn}
          listDirs={() => ["pkg"]}
        />
      )
      // Move to "Choose another folder…", open the picker, confirm the folder.
      act(() => __fireInput("", { downArrow: true }))
      act(() => __fireInput("", { return: true }))
      act(() => __fireInput("", { return: true }))
      expect(trustFolderFn).toHaveBeenCalledWith("/home/u/.cognia", path.resolve("/work"))
      const text = container.textContent ?? ""
      expect(text).not.toContain("Choose a folder")
      expect(text).not.toContain("Do you trust the files")
    })
  })

  // ── Danger-tier startup gate (--bypass / a persisted bypassPermissions) ─────
  describe("bypass acknowledgement", () => {
    const bypassConfig: ResolvedConfig = { ...config, permissionMode: "bypassPermissions" }

    it("asks before the composer accepts anything when the session opens in bypass", () => {
      const { create } = fakeSession()
      const { container } = render(
        <App config={bypassConfig} sessionId="s1" createSession={create} />
      )
      const text = container.textContent ?? ""
      expect(text).toContain("Enable bypassPermissions for this session?")
      // The load-bearing half: the mode is forwarded, not a local UI preference.
      expect(text).toMatch(/external agent/i)
    })

    it("does not ask for a mode that keeps a real approval gate", () => {
      const { create } = fakeSession()
      const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
      expect(container.textContent ?? "").not.toContain("Enable bypassPermissions")
    })

    it("waits for the trust gate before asking", () => {
      const { create } = fakeSession()
      const { container } = render(
        <App config={bypassConfig} sessionId="s1" createSession={create} trusted={false} />
      )
      const text = container.textContent ?? ""
      expect(text).toContain("Do you trust the files")
      expect(text).not.toContain("Enable bypassPermissions")
    })

    it("de-escalates to default when the acknowledgement is declined", () => {
      const { create } = fakeSession()
      const persistFn = jest.fn(() => true)
      const { container } = render(
        <App
          config={bypassConfig}
          sessionId="s1"
          createSession={create}
          home="/home/u/.cognia"
          persistConfig={persistFn}
        />
      )
      act(() => __fireInput("", { escape: true }))
      const text = container.textContent ?? ""
      expect(text).not.toContain("Enable bypassPermissions")
      // Declining must not leave the session silently armed.
      expect(persistFn).toHaveBeenCalledWith("permissionMode", "default")
    })

    it("applies the mode and stops asking once acknowledged", () => {
      const { create } = fakeSession()
      const persistFn = jest.fn(() => true)
      const { container } = render(
        <App
          config={bypassConfig}
          sessionId="s1"
          createSession={create}
          home="/home/u/.cognia"
          persistConfig={persistFn}
        />
      )
      act(() => __fireInput("", { return: true }))
      expect(persistFn).toHaveBeenCalledWith("permissionMode", "bypassPermissions")
      // Cycling back around with Shift+Tab must not re-open the confirm.
      const text = container.textContent ?? ""
      expect(text).not.toContain("Enable bypassPermissions")
    })
  })

  describe("Ctrl+R history search", () => {
    it("opens, refines, and loads a match into the composer on Enter", () => {
      const { create } = fakeSession()
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          initialHistory={["git status", "ls -la /work", "git commit -m wip"]}
        />
      )
      // Open the reverse-i-search overlay.
      act(() => __fireInput("r", { ctrl: true }))
      expect(container.textContent).toContain("(reverse-i-search)")
      // Refine the query → most-recent match wins ("git commit …").
      act(() => __fireInput("git"))
      expect(container.textContent).toContain("git commit -m wip")
      // Ctrl+R cycles to the next-older "git" match.
      act(() => __fireInput("r", { ctrl: true }))
      expect(container.textContent).toContain("git status")
      // Enter loads the match into the composer and closes the overlay.
      act(() => __fireInput("", { return: true }))
      const text = container.textContent ?? ""
      expect(text).not.toContain("(reverse-i-search)")
      expect(text).toContain("git status")
    })

    it("shows a no-match hint and cancels on Esc", () => {
      const { create } = fakeSession()
      const { container } = render(
        <App config={config} sessionId="s1" createSession={create} initialHistory={["alpha"]} />
      )
      act(() => __fireInput("r", { ctrl: true }))
      act(() => __fireInput("z"))
      expect(container.textContent).toContain("(no match)")
      act(() => __fireInput("", { escape: true }))
      expect(container.textContent).not.toContain("(reverse-i-search)")
    })
  })

  describe("Ctrl+V clipboard image", () => {
    it("appends an @<path> mention and notices on a successful read", async () => {
      const { create } = fakeSession()
      const readClipboardImage = jest.fn(async () => ({ path: "/tmp/clip.png" }))
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          readClipboardImage={readClipboardImage}
        />
      )
      await act(async () => {
        __fireInput("v", { ctrl: true })
        await Promise.resolve()
      })
      const text = container.textContent ?? ""
      expect(readClipboardImage).toHaveBeenCalled()
      expect(text).toContain("@/tmp/clip.png")
      expect(text).toContain("image from clipboard")
    })

    it("notices when the clipboard holds no image", async () => {
      const { create } = fakeSession()
      const readClipboardImage = jest.fn(async () => null)
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          readClipboardImage={readClipboardImage}
        />
      )
      await act(async () => {
        __fireInput("v", { ctrl: true })
        await Promise.resolve()
      })
      expect(container.textContent).toContain("No image in clipboard")
    })
  })
})
