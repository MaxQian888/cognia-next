import type { ExternalAgentConfig, ExternalAgentMessage } from "@/types/agent/external-agent"

// ----------------------------------------------------------------------------
// Mocks: stdio native bridge + env builder + isTauri
// ----------------------------------------------------------------------------

let stdoutCb: ((event: { agentId: string; data: string }) => void) | undefined
let stderrCb: ((event: { agentId: string; data: string }) => void) | undefined
let exitCb: ((event: { agentId: string; code: number }) => void) | undefined
const writes: string[] = []
const responders: Record<string, (msg: { id: number; params?: unknown }) => unknown> = {}

/** Responders may return `{ __error: { code, message } }` to answer with a JSON-RPC error. */
function autoRespond(agentId: string, message: string): void {
  const msg = JSON.parse(message)
  if (typeof msg.id === "number" && typeof msg.method === "string") {
    const responder = responders[msg.method]
    const result = responder ? responder(msg) : {}
    const err = (result as { __error?: { code: number; message: string } } | null)?.__error
    const reply = err ? { id: msg.id, error: err } : { id: msg.id, result }
    queueMicrotask(() => stdoutCb?.({ agentId, data: JSON.stringify(reply) }))
  }
}

jest.mock("@/lib/utils", () => ({
  ...jest.requireActual("@/lib/utils"),
  isTauri: () => true,
}))

jest.mock("./env-builder", () => ({
  buildAgentEnv: jest.fn(async () => ({ CODEX_ACCESS_TOKEN: "tok" })),
}))

jest.mock("@/lib/native/external-agent", () => ({
  spawnExternalAgent: jest.fn(async () => "proc-1"),
  sendToExternalAgent: jest.fn(async (agentId: string, message: string) => {
    writes.push(message)
    autoRespond(agentId, message)
  }),
  killExternalAgent: jest.fn(async () => {}),
  onExternalAgentStdout: jest.fn(async (cb: (e: { agentId: string; data: string }) => void) => {
    stdoutCb = cb
    return () => {
      stdoutCb = undefined
    }
  }),
  onExternalAgentStderr: jest.fn(async (cb: (e: { agentId: string; data: string }) => void) => {
    stderrCb = cb
    return () => {
      stderrCb = undefined
    }
  }),
  onExternalAgentExit: jest.fn(async (cb: (e: { agentId: string; code: number }) => void) => {
    exitCb = cb
    return () => {
      exitCb = undefined
    }
  }),
}))

import { CodexAppServerAdapter, type CodexAppServerStatus } from "./codex-app-server-client"
import { loggers } from "@cognia/logging"
import { LOG_VALUE_MAX_CHARS, truncateForLog } from "@cognia/logging/truncate"

function feed(method: string, params: Record<string, unknown>): void {
  stdoutCb?.({ agentId: "proc-1", data: JSON.stringify({ method, params }) })
}

function feedServerRequest(id: number, method: string, params: Record<string, unknown>): void {
  stdoutCb?.({ agentId: "proc-1", data: JSON.stringify({ id, method, params }) })
}

function lastWritten(
  predicate: (msg: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  for (let i = writes.length - 1; i >= 0; i--) {
    const parsed = JSON.parse(writes[i])
    if (predicate(parsed)) return parsed
  }
  return undefined
}

const config: ExternalAgentConfig = {
  id: "codex-app",
  name: "Codex (app-server)",
  protocol: "codex-app-server",
  transport: "stdio",
  enabled: true,
  process: { command: "codex", args: ["app-server"], cwd: "/work" },
}

function resetHarness() {
  stdoutCb = undefined
  stderrCb = undefined
  exitCb = undefined
  writes.length = 0
  for (const key of Object.keys(responders)) delete responders[key]
  Object.assign(responders, {
    initialize: () => ({
      userAgent: "codex-cli/1.0",
      codexHome: "/home/.codex",
      platformOs: "windows",
    }),
    "thread/start": () => ({ thread: { id: "thr_1" } }),
    "turn/start": () => ({ turn: { id: "turn_1" } }),
    "turn/interrupt": () => ({}),
    "thread/unsubscribe": () => ({}),
    // Spec shape: `ModelListResponse { data: Model[] }`, `Model { id, model, displayName }`.
    "model/list": () => ({
      data: [{ id: "gpt-5.2-codex", model: "gpt-5.2-codex", displayName: "Codex" }],
    }),
    "mcpServerStatus/list": () => ({ servers: [{ name: "fs", status: "running" }] }),
    "config/mcpServer/reload": () => ({}),
    "mcpServer/oauth/login": () => ({ authUrl: "https://auth.example" }),
    "skills/list": () => ({ skills: [{ name: "deploy", path: "/s/deploy", enabled: true }] }),
    "skills/config/write": () => ({}),
  })
}

async function connectedAdapter(): Promise<CodexAppServerAdapter> {
  const adapter = new CodexAppServerAdapter()
  await adapter.connect(config)
  return adapter
}

function userMessage(text: string): ExternalAgentMessage {
  return { id: "m1", role: "user", content: [{ type: "text", text }], timestamp: new Date() }
}

/** Get an async iterator from prompt() (declared return type is AsyncIterable). */
function iterator(
  adapter: CodexAppServerAdapter,
  sessionId: string,
  message: ExternalAgentMessage
) {
  return adapter.prompt(sessionId, message)[Symbol.asyncIterator]()
}

beforeEach(resetHarness)

describe("CodexAppServerAdapter", () => {
  describe("connect / handshake", () => {
    it("sends initialize WITHOUT a jsonrpc field and then the initialized notification", async () => {
      const adapter = await connectedAdapter()

      const init = lastWritten((m) => m.method === "initialize")!
      expect(init).toBeDefined()
      expect("jsonrpc" in init).toBe(false)
      expect((init.params as Record<string, unknown>).clientInfo).toMatchObject({ name: "cognia" })

      const initialized = lastWritten((m) => m.method === "initialized")
      expect(initialized).toBeDefined()
      expect("id" in initialized!).toBe(false)

      expect(adapter.isConnected()).toBe(true)
      expect(adapter.getServerInfo()).toMatchObject({ userAgent: "codex-cli/1.0" })
    })

    it("rejects non-stdio transport", async () => {
      const adapter = new CodexAppServerAdapter()
      await expect(adapter.connect({ ...config, transport: "http" })).rejects.toThrow(
        /only supports stdio/
      )
    })
  })

  describe("createSession", () => {
    it("maps thread/start to a session keyed by thread id", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })
      expect(session.id).toBe("thr_1")
      const started = lastWritten((m) => m.method === "thread/start")
      expect(started).toBeDefined()
    })
  })

  describe("prompt streaming", () => {
    it("maps item + turn notifications to the event stream", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()

      const it = iterator(adapter, session.id, userMessage("hi"))
      const first = it.next()

      // The listener is registered synchronously; drive the full turn.
      feed("item/started", { threadId: "thr_1", item: { id: "a1", type: "agentMessage" } })
      feed("item/agentMessage/delta", { threadId: "thr_1", itemId: "a1", delta: "Hello" })
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "a1", type: "agentMessage", text: "Hello" },
      })
      feed("thread/tokenUsage/updated", {
        threadId: "thr_1",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })

      const events: string[] = []
      let r = await first
      while (!r.done) {
        events.push(r.value.type)
        r = await it.next()
      }

      expect(events).toContain("message_start")
      expect(events).toContain("message_delta")
      expect(events).toContain("message_end")
      const done = events[events.length - 1]
      expect(done).toBe("done")

      // turn/start was sent (no jsonrpc) with the user input.
      const turn = lastWritten((m) => m.method === "turn/start")!
      expect("jsonrpc" in turn).toBe(false)
      expect((turn.params as Record<string, unknown>).threadId).toBe("thr_1")
    })

    it("emits a single message_delta from a completed item when no deltas streamed", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("hi"))
      const first = it.next()
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "a2", type: "agentMessage", text: "Full answer" },
      })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })

      const deltas: string[] = []
      let r = await first
      while (!r.done) {
        if (r.value.type === "message_delta") deltas.push(r.value.delta.text)
        r = await it.next()
      }
      expect(deltas).toEqual(["Full answer"])
    })

    it("maps a failed turn to done.success=false", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("hi"))
      const first = it.next()
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "failed" } })
      let r = await first
      let done: { success: boolean } | undefined
      while (!r.done) {
        if (r.value.type === "done") done = r.value
        r = await it.next()
      }
      expect(done?.success).toBe(false)
    })

    it("emits a canonical error event on a failed turn (parity with OpenCode/A2A)", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("hi"))
      const first = it.next()
      feed("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "failed", error: { message: "model overloaded" } },
      })
      const types: string[] = []
      let errorMsg: string | undefined
      let r = await first
      while (!r.done) {
        types.push(r.value.type)
        if (r.value.type === "error") errorMsg = r.value.error
        r = await it.next()
      }
      // The error event precedes the terminal done event.
      expect(types).toContain("error")
      expect(types.indexOf("error")).toBeLessThan(types.lastIndexOf("done"))
      expect(errorMsg).toBe("model overloaded")
    })

    it("maps an interrupted turn to a cancelled done WITHOUT an error event", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("hi"))
      const first = it.next()
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "interrupted" } })
      const types: string[] = []
      let done: { success: boolean; stopReason?: string } | undefined
      let r = await first
      while (!r.done) {
        types.push(r.value.type)
        if (r.value.type === "done") done = r.value
        r = await it.next()
      }
      expect(types).not.toContain("error")
      expect(done).toMatchObject({ success: false, stopReason: "cancelled" })
    })

    it("extracts a stable error code from codexErrorInfo variants", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()

      const run = async (errorInfo: unknown): Promise<string | undefined> => {
        const it = iterator(adapter, session.id, userMessage("hi"))
        const first = it.next()
        feed("turn/completed", {
          threadId: "thr_1",
          turn: {
            id: "turn_1",
            status: "failed",
            error: { message: "boom", codexErrorInfo: errorInfo },
          },
        })
        let code: string | undefined
        let r = await first
        while (!r.done) {
          if (r.value.type === "error") code = (r.value as { code?: string }).code
          r = await it.next()
        }
        return code
      }

      expect(await run("contextWindowExceeded")).toBe("context_window_exceeded")
      expect(await run("usageLimitExceeded")).toBe("usage_limit_exceeded")
      expect(await run({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe(
        "http_connection_failed"
      )
      expect(await run(undefined)).toBeUndefined()
    })

    it("routes commentary-phase agentMessage deltas and completions to thinking", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("hi"))
      const first = it.next()
      feed("item/started", {
        threadId: "thr_1",
        item: { id: "c1", type: "agentMessage", phase: "commentary" },
      })
      feed("item/agentMessage/delta", { threadId: "thr_1", itemId: "c1", delta: "checking…" })
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "c1", type: "agentMessage", phase: "commentary", text: "checking…" },
      })
      feed("item/started", {
        threadId: "thr_1",
        item: { id: "f1", type: "agentMessage", phase: "final_answer" },
      })
      feed("item/agentMessage/delta", { threadId: "thr_1", itemId: "f1", delta: "Answer." })
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "f1", type: "agentMessage", phase: "final_answer", text: "Answer." },
      })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })

      const thinking: string[] = []
      const deltas: string[] = []
      const starts: string[] = []
      let r = await first
      while (!r.done) {
        if (r.value.type === "thinking") thinking.push(r.value.thinking)
        if (r.value.type === "message_delta") {
          deltas.push((r.value as { delta: { text: string } }).delta.text)
        }
        if (r.value.type === "message_start" && r.value.messageId) starts.push(r.value.messageId)
        r = await it.next()
      }
      expect(thinking).toContain("checking…")
      expect(deltas).toEqual(["Answer."])
      // No message_start envelope for the commentary item.
      expect(starts).toEqual(["f1"])
    })

    it("inserts a separator on item/reasoning/summaryPartAdded", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("hi"))
      const first = it.next()
      feed("item/reasoning/summaryTextDelta", { threadId: "thr_1", itemId: "r1", delta: "part 1" })
      feed("item/reasoning/summaryPartAdded", { threadId: "thr_1", itemId: "r1" })
      feed("item/reasoning/summaryTextDelta", { threadId: "thr_1", itemId: "r1", delta: "part 2" })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      const thinking: string[] = []
      let r = await first
      while (!r.done) {
        if (r.value.type === "thinking") thinking.push(r.value.thinking)
        r = await it.next()
      }
      expect(thinking).toEqual(["part 1", "\n\n", "part 2"])
    })

    it("maps collabAgentToolCall / imageView / review-mode / contextCompaction items", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("hi"))
      const first = it.next()
      feed("item/started", {
        threadId: "thr_1",
        item: { id: "collab1", type: "collabAgentToolCall", tool: "send_message" },
      })
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "collab1", type: "collabAgentToolCall", tool: "send_message", result: "ok" },
      })
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "img1", type: "imageView", path: "/tmp/shot.png" },
      })
      feed("item/started", { threadId: "thr_1", item: { id: "rev1", type: "enteredReviewMode" } })
      feed("item/completed", { threadId: "thr_1", item: { id: "rev1", type: "exitedReviewMode" } })
      feed("item/started", { threadId: "thr_1", item: { id: "cc1", type: "contextCompaction" } })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })

      const events: Array<Record<string, unknown>> = []
      let r = await first
      while (!r.done) {
        events.push(r.value as unknown as Record<string, unknown>)
        r = await it.next()
      }
      expect(events.some((e) => e.type === "tool_use_start" && e.toolName === "send_message")).toBe(
        true
      )
      expect(
        events.some(
          (e) =>
            e.type === "tool_result" &&
            e.toolUseId === "img1" &&
            (e.result as { path?: string })?.path === "/tmp/shot.png"
        )
      ).toBe(true)
      const modeUpdates = events.filter((e) => e.type === "mode_update").map((e) => e.modeId)
      expect(modeUpdates).toEqual(["review", "default"])
      expect(events.some((e) => e.type === "progress" && e.message === "context_compaction")).toBe(
        true
      )
      expect(adapter.getSession(session.id)?.metadata?.contextCompacted).toBe(true)
    })
  })

  describe("session extension support", () => {
    it("starts at unknown and marks supported after a successful thread/list", async () => {
      responders["thread/list"] = () => ({
        data: [
          { id: "thr_a", name: "Fix build", createdAt: 1750000000, updatedAt: 1750003600 },
          { id: "thr_b", preview: "hello preview" },
        ],
      })
      const adapter = await connectedAdapter()
      expect(adapter.getSessionExtensionSupport()["session/list"].state).toBe("unknown")

      const sessions = await adapter.listSessions()
      expect(sessions).toEqual([
        {
          sessionId: "thr_a",
          title: "Fix build",
          createdAt: new Date(1750000000 * 1000).toISOString(),
          updatedAt: new Date(1750003600 * 1000).toISOString(),
        },
        { sessionId: "thr_b", title: "hello preview", createdAt: undefined, updatedAt: undefined },
      ])
      const listReq = lastWritten((m) => m.method === "thread/list")!
      expect(listReq.params).toMatchObject({ sortKey: "updated_at", sortDirection: "desc" })
      expect(adapter.getSessionExtensionSupport()["session/list"].state).toBe("supported")
    })

    it("marks thread/list unsupported on -32601 and throws the shared typed error", async () => {
      responders["thread/list"] = () => ({
        __error: { code: -32601, message: "Method not found" },
      })
      const adapter = await connectedAdapter()
      await expect(adapter.listSessions()).rejects.toThrow(/does not support session listing/i)
      expect(adapter.getSessionExtensionSupport()["session/list"].state).toBe("unsupported")
      // Second call short-circuits from the cache without a wire round-trip.
      const before = writes.length
      await expect(adapter.listSessions()).rejects.toThrow(/does not support session listing/i)
      expect(writes.length).toBe(before)
    })

    it("resumes a thread, hydrates history, and never re-prepends the system prompt", async () => {
      responders["thread/resume"] = () => ({
        thread: { id: "thr_res" },
        model: "gpt-5.2-codex",
        reasoningEffort: "high",
        initialTurnsPage: {
          data: [
            {
              items: [
                { id: "u1", type: "userMessage", text: "hi" },
                { id: "a1", type: "agentMessage", text: "hello!", phase: "final_answer" },
                { id: "c1", type: "agentMessage", text: "working…", phase: "commentary" },
              ],
            },
          ],
        },
      })
      const adapter = await connectedAdapter()
      const session = await adapter.resumeSession("thr_res", { systemPrompt: "You are helpful." })
      expect(session.id).toBe("thr_res")
      expect(session.messages).toHaveLength(2)
      expect(session.messages?.[0]).toMatchObject({ role: "user" })
      expect(session.messages?.[1]).toMatchObject({ role: "assistant" })
      expect(session.metadata?.selectedModel).toBe("gpt-5.2-codex")
      expect(session.metadata?.reasoningEffort).toBe("high")
      expect(adapter.getSessionExtensionSupport()["session/resume"].state).toBe("supported")

      // The next turn must not re-send the system prompt as a text prepend.
      const it = iterator(adapter, session.id, userMessage("continue"))
      const first = it.next()
      feed("turn/completed", { threadId: "thr_res", turn: { id: "t1", status: "completed" } })
      let r = await first
      while (!r.done) r = await it.next()
      const turn = lastWritten((m) => m.method === "turn/start")!
      const input = (turn.params as { input: Array<{ text?: string }> }).input
      expect(input[0].text).toBe("continue")
    })

    it("forks a thread into a new session copying source metadata", async () => {
      responders["thread/fork"] = () => ({ thread: { id: "thr_fork" } })
      const adapter = await connectedAdapter()
      const source = await adapter.createSession({ cwd: "/repo" })
      const forked = await adapter.forkSession(source.id)
      expect(forked.id).toBe("thr_fork")
      expect(forked.metadata).toMatchObject({ cwd: "/repo", forkedFrom: source.id })
      expect(adapter.getSession("thr_fork")).toBeDefined()
    })

    it("deleteSession sends thread/delete and drops local state", async () => {
      responders["thread/delete"] = () => ({})
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      await adapter.deleteSession(session.id)
      expect(lastWritten((m) => m.method === "thread/delete")).toBeDefined()
      expect(adapter.getSession(session.id)).toBeUndefined()
    })
  })

  describe("thread housekeeping", () => {
    it("compactSession and rollbackSession send the thread requests", async () => {
      responders["thread/compact/start"] = () => ({})
      responders["thread/rollback"] = () => ({})
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      await adapter.compactSession(session.id)
      expect(lastWritten((m) => m.method === "thread/compact/start")?.params).toEqual({
        threadId: session.id,
      })
      await adapter.rollbackSession(session.id, 2)
      expect(lastWritten((m) => m.method === "thread/rollback")?.params).toEqual({
        threadId: session.id,
        numTurns: 2,
      })
      expect(adapter.supportsCompaction()).toBe(true)
    })

    it("updates the session title from thread/name/updated", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      feed("thread/name/updated", { threadId: session.id, threadName: "Renamed" })
      expect(adapter.getSession(session.id)?.metadata?.title).toBe("Renamed")
    })

    it("ends and drops the session on thread/closed", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      feed("thread/closed", { threadId: session.id })
      expect(adapter.getSession(session.id)).toBeUndefined()
    })

    it("mirrors thread/status/changed onto the session status", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      feed("thread/status/changed", { threadId: session.id, status: { type: "systemError" } })
      expect(adapter.getSession(session.id)?.status).toBe("error")
      feed("thread/status/changed", { threadId: session.id, status: { type: "idle" } })
      expect(adapter.getSession(session.id)?.status).toBe("idle")
    })
  })

  describe("approvals", () => {
    it("surfaces a command approval and resolves it with the UI decision", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })

      const events: Array<{ type: string }> = []
      const unsub = adapter.onStatusUpdate(() => {})
      const it = iterator(adapter, session.id, userMessage("run ls"))
      const first = it.next()

      feedServerRequest(50, "item/commandExecution/requestApproval", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "cmd1",
        command: "ls -la",
        cwd: "/work",
      })

      // Pull until the permission_request surfaces.
      let r = await first
      let sawPermission = false
      while (!r.done) {
        events.push(r.value)
        if (r.value.type === "permission_request") {
          sawPermission = true
          await adapter.respondToPermission(session.id, { requestId: "cmd1", granted: true })
          feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
        }
        r = await it.next()
      }
      expect(sawPermission).toBe(true)

      const decision = lastWritten((m) => m.id === 50 && m.result !== undefined)
      expect(decision?.result).toEqual({ decision: "accept" })
      unsub()
    })

    it("auto-declines in plan mode without surfacing UI", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "plan" })
      const it = iterator(adapter, session.id, userMessage("run rm"))
      const first = it.next()
      feedServerRequest(60, "item/fileChange/requestApproval", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "fc1",
      })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      let r = await first
      const types: string[] = []
      while (!r.done) {
        types.push(r.value.type)
        r = await it.next()
      }
      expect(types).not.toContain("permission_request")
      const decision = lastWritten((m) => m.id === 60 && m.result !== undefined)
      expect(decision?.result).toEqual({ decision: "decline" })
    })

    it("auto-accepts file changes in acceptEdits mode", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "acceptEdits" })
      const it = iterator(adapter, session.id, userMessage("edit"))
      const first = it.next()
      feedServerRequest(61, "item/fileChange/requestApproval", { threadId: "thr_1", itemId: "fc2" })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      let r = await first
      while (!r.done) r = await it.next()
      const decision = lastWritten((m) => m.id === 61 && m.result !== undefined)
      expect(decision?.result).toEqual({ decision: "accept" })
    })

    it("surfaces item/tool/requestUserInput as an interactive permission_request and forwards answers", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })
      const it = iterator(adapter, session.id, userMessage("ask me"))
      const first = it.next()
      feedServerRequest(70, "item/tool/requestUserInput", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "q-item",
        questions: [
          {
            id: "q1",
            header: "Region",
            question: "Which region?",
            options: [
              { label: "us-east", description: "Virginia" },
              { label: "eu-west", description: "Ireland" },
            ],
            isOther: true,
          },
        ],
      })
      let r = await first
      let request: Record<string, unknown> | undefined
      while (!r.done) {
        if (r.value.type === "permission_request") {
          request = r.value.request as unknown as Record<string, unknown>
          await adapter.respondToPermission(session.id, {
            requestId: "q-item",
            granted: true,
            answers: { q1: ["eu-west"] },
          })
          feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
        }
        r = await it.next()
      }
      expect(request).toBeDefined()
      expect(request!.title).toBe("Region")
      const meta = (request!.metadata as { codexUserInput: Record<string, unknown> }).codexUserInput
      expect(meta.questions).toHaveLength(1)
      expect((request!.options as Array<{ optionId: string }>).map((o) => o.optionId)).toEqual([
        "q1:us-east",
        "q1:eu-west",
      ])

      const reply = lastWritten((m) => m.id === 70 && m.result !== undefined)
      expect(reply?.result).toEqual({ answers: { q1: { answers: ["eu-west"] } } })
      expect(lastWritten((m) => m.id === 70 && m.error !== undefined)).toBeUndefined()
    })

    it("maps a plain optionId pick onto the question answer", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })
      const it = iterator(adapter, session.id, userMessage("ask me"))
      const first = it.next()
      feedServerRequest(71, "item/tool/requestUserInput", {
        threadId: "thr_1",
        itemId: "q-item-2",
        questions: [{ id: "q1", question: "Pick one", options: [{ label: "a" }, { label: "b" }] }],
      })
      let r = await first
      while (!r.done) {
        if (r.value.type === "permission_request") {
          await adapter.respondToPermission(session.id, {
            requestId: "q-item-2",
            granted: true,
            optionId: "q1:b",
          })
          feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
        }
        r = await it.next()
      }
      const reply = lastWritten((m) => m.id === 71 && m.result !== undefined)
      expect(reply?.result).toEqual({ answers: { q1: { answers: ["b"] } } })
    })

    it("auto-resolves requestUserInput with empty answers when autoResolutionMs elapses", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })
      const events: Array<{ type: string }> = []
      const it = iterator(adapter, session.id, userMessage("ask me"))
      const first = it.next()
      // A short real auto-resolution window: fake timers would also freeze the
      // harness's queueMicrotask-based auto-responder.
      feedServerRequest(72, "item/tool/requestUserInput", {
        threadId: "thr_1",
        itemId: "q-timed",
        autoResolutionMs: 25,
        questions: [{ id: "q1", question: "Still there?" }],
      })
      let r = await first
      let completed = false
      while (!r.done) {
        events.push(r.value)
        if (r.value.type === "permission_response" && !completed) {
          completed = true
          feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
        }
        r = await it.next()
      }
      const reply = lastWritten((m) => m.id === 72 && m.result !== undefined)
      expect(reply?.result).toEqual({ answers: { q1: { answers: [] } } })
      expect(events.some((e) => e.type === "permission_response")).toBe(true)
    })

    it("cancels pending requests when serverRequest/resolved arrives", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })
      const it = iterator(adapter, session.id, userMessage("ask me"))
      const first = it.next()
      feedServerRequest(73, "item/tool/requestUserInput", {
        threadId: "thr_1",
        itemId: "q-resolved",
        questions: [{ id: "q1", question: "Resolved elsewhere?" }],
      })
      let r = await first
      let sawResponse = false
      while (!r.done) {
        if (r.value.type === "permission_request") {
          feed("serverRequest/resolved", { threadId: "thr_1", requestId: 73 })
          feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
        }
        if (r.value.type === "permission_response") sawResponse = true
        r = await it.next()
      }
      expect(sawResponse).toBe(true)
      const reply = lastWritten((m) => m.id === 73 && m.result !== undefined)
      expect(reply?.result).toEqual({ answers: { q1: { answers: [] } } })
    })

    it("forwards availableDecisions and commandActions into the approval request metadata", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })
      const it = iterator(adapter, session.id, userMessage("run"))
      const first = it.next()
      feedServerRequest(74, "item/commandExecution/requestApproval", {
        threadId: "thr_1",
        itemId: "cmd-meta",
        command: "curl https://example.com",
        availableDecisions: ["accept", "decline", "cancel"],
        commandActions: [{ kind: "network" }],
      })
      let r = await first
      let request: Record<string, unknown> | undefined
      while (!r.done) {
        if (r.value.type === "permission_request") {
          request = r.value.request as unknown as Record<string, unknown>
          await adapter.respondToPermission(session.id, { requestId: "cmd-meta", granted: false })
          feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
        }
        r = await it.next()
      }
      expect(request?.metadata).toMatchObject({
        availableDecisions: ["accept", "decline", "cancel"],
        commandActions: [{ kind: "network" }],
      })
    })
  })

  describe("cancel", () => {
    it("sends turn/interrupt for the active turn", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("long task"))
      const first = it.next()
      // let turn/start round-trip so the active turn id is recorded
      await Promise.resolve()
      await Promise.resolve()
      await adapter.cancel(session.id)
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "interrupted" } })
      let r = await first
      while (!r.done) r = await it.next()
      const interrupt = lastWritten((m) => m.method === "turn/interrupt")
      expect(interrupt).toBeDefined()
      expect((interrupt!.params as Record<string, unknown>).turnId).toBe("turn_1")
    })
  })

  describe("models", () => {
    it("lists models and records a session selection", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const models = await adapter.listModels()
      expect(models).toEqual([{ id: "gpt-5.2-codex", name: "Codex" }])
      await adapter.setSessionModel(session.id, "gpt-5.2-codex")
      expect(adapter.getSession(session.id)?.metadata?.selectedModel).toBe("gpt-5.2-codex")
    })
  })

  describe("native MCP + skills", () => {
    it("refreshes MCP server status and notifies listeners", async () => {
      const adapter = await connectedAdapter()
      const seen: unknown[] = []
      adapter.onStatusUpdate((s) => seen.push(s))
      const servers = await adapter.refreshMcpServers()
      expect(servers).toEqual([{ name: "fs", status: "running" }])
      expect(seen.length).toBeGreaterThan(0)
    })

    it("starts an MCP OAuth login and returns the auth url", async () => {
      const adapter = await connectedAdapter()
      const result = await adapter.startMcpOAuthLogin("github")
      expect(result.authUrl).toBe("https://auth.example")
    })

    it("lists skills and toggles one", async () => {
      const adapter = await connectedAdapter()
      const skills = await adapter.refreshSkills(["/work"])
      expect(skills).toEqual([{ name: "deploy", path: "/s/deploy", enabled: true }])
      await adapter.setSkillEnabled("/s/deploy", false)
      const write = lastWritten((m) => m.method === "skills/config/write")
      expect((write!.params as Record<string, unknown>).enabled).toBe(false)
    })

    it("registers extra skill roots (trimmed + de-duped) and refreshes the list", async () => {
      const adapter = await connectedAdapter()
      const seen: CodexAppServerStatus[] = []
      adapter.onStatusUpdate((s) => seen.push(s))
      const ok = await adapter.setExtraSkillRoots([" /a ", "/a", "/b", "  "])
      expect(ok).toBe(true)
      const write = lastWritten((m) => m.method === "skills/extraRoots/set")
      expect((write!.params as Record<string, unknown>).extraRoots).toEqual(["/a", "/b"])
      expect(adapter.getStatus().skills).toEqual([
        { name: "deploy", path: "/s/deploy", enabled: true },
      ])
      expect(adapter.getStatus().extraSkillRootsUnsupported).toBe(false)
      expect(seen.length).toBeGreaterThan(0)
    })

    it("flags unsupported extra skill roots on older CLIs and skips the refresh", async () => {
      const adapter = await connectedAdapter()
      responders["skills/extraRoots/set"] = () => ({
        __error: { code: -32601, message: "method not found" },
      })
      writes.length = 0
      const ok = await adapter.setExtraSkillRoots(["/a"])
      expect(ok).toBe(false)
      expect(adapter.getStatus().extraSkillRootsUnsupported).toBe(true)
      expect(lastWritten((m) => m.method === "skills/list")).toBeUndefined()
    })

    it("returns false from setExtraSkillRoots when not connected", async () => {
      const adapter = new CodexAppServerAdapter()
      expect(await adapter.setExtraSkillRoots(["/a"])).toBe(false)
    })

    it("re-registers configured extra skill roots on connect", async () => {
      const adapter = new CodexAppServerAdapter()
      await adapter.connect({
        ...config,
        codexOptions: { extraSkillRoots: ["/team/skills", "/team/skills", " "] },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const write = lastWritten((m) => m.method === "skills/extraRoots/set")
      expect(write).toBeDefined()
      expect((write!.params as Record<string, unknown>).extraRoots).toEqual(["/team/skills"])
    })

    it("skips extra-root registration on connect when none are configured", async () => {
      await connectedAdapter()
      expect(lastWritten((m) => m.method === "skills/extraRoots/set")).toBeUndefined()
    })

    it("connects cleanly even when extra-root registration errors", async () => {
      responders["skills/extraRoots/set"] = () => ({
        __error: { code: -32000, message: "boom" },
      })
      const adapter = new CodexAppServerAdapter()
      await adapter.connect({
        ...config,
        codexOptions: { extraSkillRoots: ["/team/skills"] },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(adapter.isConnected()).toBe(true)
    })
  })

  describe("disconnect", () => {
    it("kills the process and clears state", async () => {
      const adapter = await connectedAdapter()
      await adapter.createSession()
      await adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)
      expect(adapter.getSessions()).toHaveLength(0)
    })

    it("marks disconnected when the process exits", async () => {
      const adapter = await connectedAdapter()
      exitCb?.({ agentId: "proc-1", code: 1 })
      expect(adapter.connectionStatus).toBe("disconnected")
    })

    it("resolves a pending approval to cancel on disconnect", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })
      const it = iterator(adapter, session.id, userMessage("run"))
      const first = it.next()
      feedServerRequest(70, "item/commandExecution/requestApproval", {
        threadId: "thr_1",
        itemId: "cmdX",
        command: "rm",
      })
      // Pull the permission_request, then disconnect while it's pending. The
      // pending approval is resolved to "cancel" during teardown (the write
      // itself can't land — the process is already gone).
      let r = await first
      let sawPermission = false
      while (!r.done) {
        if (r.value.type === "permission_request") {
          sawPermission = true
          await adapter.disconnect()
          break
        }
        r = await it.next()
      }
      expect(sawPermission).toBe(true)
      expect(adapter.isConnected()).toBe(false)
    })
  })

  describe("rich item stream", () => {
    it("maps command / fileChange / mcpToolCall / reasoning / webSearch / plan items", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("do everything"))
      const first = it.next()

      feed("item/started", {
        threadId: "thr_1",
        item: { id: "c1", type: "commandExecution", command: "ls", cwd: "/work" },
      })
      feed("item/commandExecution/outputDelta", {
        threadId: "thr_1",
        itemId: "c1",
        stream: "stdout",
        // Spec: `delta` is a plain UTF-8 string, not a base64 field.
        delta: "hello",
      })
      feed("item/completed", {
        threadId: "thr_1",
        item: {
          id: "c1",
          type: "commandExecution",
          command: "ls",
          cwd: "/work",
          aggregatedOutput: "hello",
          exitCode: 2,
        },
      })
      feed("item/started", {
        threadId: "thr_1",
        item: { id: "f1", type: "fileChange", changes: [{ path: "a" }] },
      })
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "f1", type: "fileChange", changes: [{ path: "a" }], status: "failed" },
      })
      feed("item/started", {
        threadId: "thr_1",
        item: { id: "m1", type: "mcpToolCall", tool: "search", arguments: { q: "x" } },
      })
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "m1", type: "mcpToolCall", tool: "search", result: "ok", error: "boom" },
      })
      feed("item/reasoning/textDelta", { threadId: "thr_1", itemId: "r1", delta: "thinking…" })
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "r2", type: "reasoning", content: "final reasoning" },
      })
      feed("item/started", {
        threadId: "thr_1",
        item: { id: "w1", type: "webSearch", query: "cats" },
      })
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "w1", type: "webSearch", query: "cats" },
      })
      feed("turn/plan/updated", {
        threadId: "thr_1",
        plan: [
          { step: "a", status: "completed" },
          { step: "b", status: "pending" },
        ],
      })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })

      const events: Array<{ type: string }> = []
      let r = await first
      while (!r.done) {
        events.push(r.value)
        r = await it.next()
      }
      const types = events.map((e) => e.type)
      expect(types.filter((t) => t === "tool_use_start").length).toBeGreaterThanOrEqual(4)
      expect(types).toContain("tool_use_delta")
      expect(types).toContain("tool_result")
      expect(types).toContain("thinking")
      expect(types).toContain("plan_update")
    })

    it("streams item/plan/delta as thinking, dedupes the plan item, and records turn/diff", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("plan it"))
      const first = it.next()

      feed("item/plan/delta", { threadId: "thr_1", itemId: "p1", delta: "Step 1: scope" })
      // The completed plan item for the same id must NOT re-emit (deduped).
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "p1", type: "plan", text: "Step 1: scope" },
      })
      feed("turn/diff/updated", { threadId: "thr_1", turnId: "turn_1", diff: "--- a\n+++ b\n" })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })

      const thinks: string[] = []
      let r = await first
      while (!r.done) {
        if (r.value.type === "thinking") thinks.push((r.value as { thinking: string }).thinking)
        r = await it.next()
      }
      expect(thinks).toEqual(["Step 1: scope"]) // streamed once, not duplicated by item/completed
      const meta = (
        adapter as unknown as { _sessions: Map<string, { metadata?: Record<string, unknown> }> }
      )._sessions.get(session.id)?.metadata
      expect(meta?.turnDiff).toContain("+++ b")
    })

    it("emits a plan item's text as thinking when it was not streamed", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("plan"))
      const first = it.next()
      feed("item/completed", {
        threadId: "thr_1",
        item: { id: "p2", type: "plan", text: "Do the thing" },
      })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      const thinks: string[] = []
      let r = await first
      while (!r.done) {
        if (r.value.type === "thinking") thinks.push((r.value as { thinking: string }).thinking)
        r = await it.next()
      }
      expect(thinks).toContain("Do the thing")
    })

    it("falls back to the single open session when a notification omits threadId", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("hi"))
      const first = it.next()
      // No threadId on the frame → single-session fallback resolves it.
      feed("item/started", { item: { id: "a9", type: "agentMessage" } })
      feed("turn/completed", { turn: { id: "turn_1", status: "completed" } })
      let r = await first
      const types: string[] = []
      while (!r.done) {
        types.push(r.value.type)
        r = await it.next()
      }
      expect(types).toContain("message_start")
    })
  })

  describe("status notifications + lifecycle", () => {
    it("applies an MCP startup-status notification and notifies listeners", async () => {
      const adapter = await connectedAdapter()
      const seen: unknown[] = []
      adapter.onStatusUpdate((s) => seen.push(s))
      feed("mcpServer/startupStatus/updated", { servers: [{ name: "github", status: "ready" }] })
      expect(adapter.getStatus().mcpServers).toEqual([{ name: "github", status: "ready" }])
      expect(seen.length).toBeGreaterThan(0)
    })

    it("refreshes skills when a skills/changed notification arrives", async () => {
      const adapter = await connectedAdapter()
      feed("skills/changed", {})
      await Promise.resolve()
      await Promise.resolve()
      expect(adapter.getStatus().skills).toEqual([
        { name: "deploy", path: "/s/deploy", enabled: true },
      ])
    })

    it("reloadMcpConfig sends the reload request and refreshes", async () => {
      const adapter = await connectedAdapter()
      await adapter.reloadMcpConfig()
      expect(lastWritten((m) => m.method === "config/mcpServer/reload")).toBeDefined()
      expect(adapter.getStatus().mcpServers).toEqual([{ name: "fs", status: "running" }])
    })

    it("closeSession unsubscribes and drops the session", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      await adapter.closeSession(session.id)
      expect(adapter.getSession(session.id)).toBeUndefined()
      expect(lastWritten((m) => m.method === "thread/unsubscribe")).toBeDefined()
    })

    it("setSessionMode updates the session permission mode", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })
      await adapter.setSessionMode(session.id, "acceptEdits")
      expect(adapter.getSession(session.id)?.permissionMode).toBe("acceptEdits")
    })

    it("emits an error event when turn/start rejects", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      responders["turn/start"] = () => {
        throw new Error("nope")
      }
      // Make the responder send an error response instead of a result.
      const { sendToExternalAgent } = jest.requireMock("@/lib/native/external-agent") as {
        sendToExternalAgent: jest.Mock
      }
      sendToExternalAgent.mockImplementationOnce(async (agentId: string, message: string) => {
        writes.push(message)
        const msg = JSON.parse(message)
        if (msg.method === "turn/start") {
          queueMicrotask(() =>
            stdoutCb?.({
              agentId,
              data: JSON.stringify({ id: msg.id, error: { code: -32000, message: "boom" } }),
            })
          )
        }
      })
      const it = iterator(adapter, session.id, userMessage("go"))
      const types: string[] = []
      // prompt() yields the error event, then rethrows it on the final next().
      try {
        let r = await it.next()
        while (!r.done) {
          types.push(r.value.type)
          r = await it.next()
        }
      } catch {
        // expected — the turn error is rethrown after the stream drains
      }
      expect(types).toContain("error")
    })
  })

  describe("input mapping + model selection", () => {
    it("maps image / file content and passes the selected model on turn/start", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ cwd: "/repo" })
      await adapter.setSessionModel(session.id, "gpt-5.2-codex")

      const message: ExternalAgentMessage = {
        id: "mm",
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: { type: "url", url: "https://img/x.png", mediaType: "image/png" },
          },
          { type: "image", source: { type: "base64", data: "abc", mediaType: "image/png" } },
          { type: "file", path: "/repo/pic.png" },
          { type: "file", path: "/repo/notes.txt" },
        ],
        timestamp: new Date(),
      }
      const it = adapter.prompt(session.id, message)[Symbol.asyncIterator]()
      const first = it.next()
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      let r = await first
      while (!r.done) r = await it.next()

      const turn = lastWritten((m) => m.method === "turn/start")!
      const params = turn.params as { input: Array<{ type: string }>; model?: string; cwd?: string }
      expect(params.model).toBe("gpt-5.2-codex")
      expect(params.cwd).toBe("/repo")
      const inputTypes = params.input.map((i) => i.type)
      expect(inputTypes).toContain("image") // url image
      expect(inputTypes).toContain("localImage") // image file path
      // base64 image + non-image file fall back to text items
      expect(params.input.filter((i) => i.type === "text").length).toBeGreaterThanOrEqual(2)
    })

    it("carries the brief-aware system prompt via thread/start developerInstructions", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({
        systemPrompt: "You are a release bot.",
        briefMode: true,
      })
      const started = lastWritten((m) => m.method === "thread/start")!
      const dev = (started.params as { developerInstructions?: string }).developerInstructions
      expect(dev).toContain("Respond concisely")
      expect(dev).toContain("You are a release bot.")

      // The prompt must NOT be duplicated as a leading turn input.
      const it = iterator(adapter, session.id, userMessage("ship it"))
      const first = it.next()
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      let r = await first
      while (!r.done) r = await it.next()
      const turn = lastWritten((m) => m.method === "turn/start")!
      const input = (turn.params as { input: Array<{ type: string; text?: string }> }).input
      expect(input[0].text).toBe("ship it")
    })

    it("sends effort, summary, and sandboxPolicy on turn/start from session options", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({
        metadata: {
          codexOptions: {
            sandboxMode: "workspaceWrite",
            networkAccess: true,
            writableRoots: ["/extra"],
            defaultReasoningEffort: "high",
            reasoningSummary: "detailed",
          },
        },
      })
      // thread/start already carries the sandbox default.
      const started = lastWritten((m) => m.method === "thread/start")!
      expect((started.params as { sandbox?: unknown }).sandbox).toEqual({
        type: "workspaceWrite",
        networkAccess: true,
        writableRoots: ["/extra"],
      })

      const it = iterator(adapter, session.id, userMessage("go"))
      const first = it.next()
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      let r = await first
      while (!r.done) r = await it.next()

      const turn = lastWritten((m) => m.method === "turn/start")!
      expect(turn.params).toMatchObject({
        effort: "high",
        summary: "detailed",
        sandboxPolicy: { type: "workspaceWrite", networkAccess: true, writableRoots: ["/extra"] },
        approvalPolicy: "on-request",
      })
    })

    it("maps a readOnly sandbox mode without network access", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({
        metadata: { codexOptions: { sandboxMode: "readOnly" } },
      })
      const it = iterator(adapter, session.id, userMessage("inspect"))
      const first = it.next()
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      let r = await first
      while (!r.done) r = await it.next()
      const turn = lastWritten((m) => m.method === "turn/start")!
      expect((turn.params as { sandboxPolicy?: unknown }).sandboxPolicy).toEqual({
        type: "readOnly",
      })
    })
  })

  describe("turn/steer", () => {
    it("appends input to the active turn and tracks the returned turn id", async () => {
      responders["turn/steer"] = () => ({ turnId: "turn_2" })
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      const it = iterator(adapter, session.id, userMessage("start"))
      const first = it.next()
      feed("turn/started", { threadId: "thr_1", turn: { id: "turn_1" } })
      await Promise.resolve()
      await adapter.steerTurn(session.id, "also check the tests")
      const steer = lastWritten((m) => m.method === "turn/steer")!
      expect(steer.params).toEqual({
        threadId: "thr_1",
        expectedTurnId: "turn_1",
        input: [{ type: "text", text: "also check the tests" }],
      })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_2", status: "completed" } })
      let r = await first
      while (!r.done) r = await it.next()
    })

    it("throws when no turn is active and when the method is unsupported", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession()
      await expect(adapter.steerTurn(session.id, "x")).rejects.toThrow(/no active turn/i)

      responders["turn/steer"] = () => ({
        __error: { code: -32601, message: "Method not found" },
      })
      const it = iterator(adapter, session.id, userMessage("start"))
      const first = it.next()
      feed("turn/started", { threadId: "thr_1", turn: { id: "turn_1" } })
      await Promise.resolve()
      await expect(adapter.steerTurn(session.id, "x")).rejects.toThrow(/not supported/i)
      // Cached: the second call fails fast without a wire round-trip.
      await expect(adapter.steerTurn(session.id, "y")).rejects.toThrow(/not supported/i)
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      let r = await first
      while (!r.done) r = await it.next()
    })
  })

  describe("session config options", () => {
    it("synthesizes effort + sandbox options and applies setConfigOption", async () => {
      responders["model/list"] = () => ({
        data: [
          {
            id: "gpt-5.2-codex",
            displayName: "Codex",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high", description: "thorough" },
            ],
          },
        ],
      })
      const adapter = await connectedAdapter()
      await adapter.listModels()
      const session = await adapter.createSession()

      const options = adapter.getConfigOptions(session.id)!
      const effort = options.find((o) => o.id === "reasoningEffort")!
      expect(effort.currentValue).toBe("medium")
      expect(effort.options.map((o) => o.value)).toEqual(["low", "medium", "high"])
      const sandbox = options.find((o) => o.id === "sandboxMode")!
      expect(sandbox.currentValue).toBe("workspaceWrite")

      const updated = await adapter.setConfigOption(session.id, "reasoningEffort", "high")
      expect(updated.find((o) => o.id === "reasoningEffort")?.currentValue).toBe("high")
      expect(adapter.getSession(session.id)?.metadata?.reasoningEffort).toBe("high")

      await adapter.setConfigOption(session.id, "sandboxMode", "readOnly")
      expect(adapter.getSession(session.id)?.metadata?.sandboxMode).toBe("readOnly")
      await expect(adapter.setConfigOption(session.id, "bogus", "x")).rejects.toThrow(
        /unknown config option/i
      )
    })

    it("resets the effort to the model default when the model changes", async () => {
      responders["model/list"] = () => ({
        data: [
          { id: "a", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
          { id: "b", defaultReasoningEffort: "xhigh", supportedReasoningEfforts: [] },
        ],
      })
      const adapter = await connectedAdapter()
      await adapter.listModels()
      const session = await adapter.createSession()
      await adapter.setConfigOption(session.id, "reasoningEffort", "low")
      await adapter.setSessionModel(session.id, "b")
      expect(adapter.getSession(session.id)?.metadata?.reasoningEffort).toBe("xhigh")
      const models = adapter.getSessionModels(session.id)!
      expect(models.currentModelId).toBe("b")
      expect(models.availableModels.map((m) => m.modelId)).toEqual(["a", "b"])
    })
  })

  describe("account + rate limits", () => {
    it("fetches account and rate limits on connect and exposes them via status", async () => {
      responders["account/read"] = () => ({
        account: { type: "chatgpt", email: "dev@example.com", planType: "pro" },
        requiresOpenaiAuth: false,
      })
      responders["account/rateLimits/read"] = () => ({
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1750010000 },
          secondary: { usedPercent: 7 },
        },
      })
      const adapter = await connectedAdapter()
      // connect fires refreshAccount asynchronously; wait for it directly.
      await adapter.refreshAccount()
      const status = adapter.getStatus()
      expect(status.account).toEqual({ type: "chatgpt", email: "dev@example.com", planType: "pro" })
      expect(status.requiresOpenaiAuth).toBe(false)
      expect(status.rateLimits).toEqual({
        planType: "pro",
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1750010000 },
        secondary: { usedPercent: 7, windowDurationMins: undefined, resetsAt: undefined },
        rateLimitReachedType: undefined,
      })
    })

    it("degrades silently when the account surface is unsupported", async () => {
      responders["account/read"] = () => ({
        __error: { code: -32601, message: "Method not found" },
      })
      responders["account/rateLimits/read"] = () => ({
        __error: { code: -32601, message: "Method not found" },
      })
      const adapter = await connectedAdapter()
      await adapter.refreshAccount()
      const status = adapter.getStatus()
      expect(status.account).toBeUndefined()
      expect(status.rateLimits).toBeUndefined()
      expect(adapter.isConnected()).toBe(true)
    })

    it("applies account/rateLimits/updated notifications to the status", async () => {
      const adapter = await connectedAdapter()
      const updates: Array<Record<string, unknown>> = []
      const unsub = adapter.onStatusUpdate((s) =>
        updates.push(s as unknown as Record<string, unknown>)
      )
      feed("account/rateLimits/updated", {
        rateLimits: { primary: { usedPercent: 91, resetsAt: 1750099999 } },
      })
      expect(adapter.getStatus().rateLimits?.primary?.usedPercent).toBe(91)
      expect(updates.length).toBeGreaterThan(0)
      unsub()
    })
  })

  describe("healthCheck", () => {
    it("returns false when never connected", async () => {
      const adapter = new CodexAppServerAdapter()
      await expect(adapter.healthCheck()).resolves.toBe(false)
    })

    it("returns true when the model/list probe round-trips", async () => {
      const adapter = await connectedAdapter()
      await expect(adapter.healthCheck()).resolves.toBe(true)
      // The probe is the read-only model/list request (no side effects).
      expect(lastWritten((m) => m.method === "model/list")).toBeDefined()
    })

    it("treats a JSON-RPC error response as alive (server answered)", async () => {
      const adapter = await connectedAdapter()
      const native = jest.requireMock("@/lib/native/external-agent") as {
        sendToExternalAgent: jest.Mock
      }
      native.sendToExternalAgent.mockImplementationOnce(
        async (agentId: string, message: string) => {
          writes.push(message)
          const msg = JSON.parse(message)
          queueMicrotask(() =>
            stdoutCb?.({
              agentId,
              data: JSON.stringify({ id: msg.id, error: { code: -32601, message: "unknown" } }),
            })
          )
        }
      )
      await expect(adapter.healthCheck()).resolves.toBe(true)
    })

    it("returns false when the probe times out", async () => {
      const adapter = await connectedAdapter()
      const native = jest.requireMock("@/lib/native/external-agent") as {
        sendToExternalAgent: jest.Mock
      }
      // Swallow the probe write so no response ever arrives.
      native.sendToExternalAgent.mockImplementationOnce(
        async (_agentId: string, message: string) => {
          writes.push(message)
        }
      )
      jest.useFakeTimers()
      try {
        const probe = adapter.healthCheck()
        await jest.advanceTimersByTimeAsync(5001)
        await expect(probe).resolves.toBe(false)
      } finally {
        jest.useRealTimers()
      }
    })
  })
})

describe("CodexAppServerAdapter — stderr forwarding", () => {
  it("forwards subprocess stderr at debug (not warn) and truncates oversized chunks", async () => {
    const debugSpy = jest.spyOn(loggers.agent, "debug").mockImplementation(() => {})
    const warnSpy = jest.spyOn(loggers.agent, "warn").mockImplementation(() => {})
    try {
      await connectedAdapter()
      expect(stderrCb).toBeDefined()

      const huge = "E".repeat(LOG_VALUE_MAX_CHARS + 4096)
      stderrCb!({ agentId: "proc-1", data: huge })

      // Routed to debug (not forwarded by Next's dev server), never to warn.
      expect(debugSpy).toHaveBeenCalledWith("Codex app-server stderr", {
        data: truncateForLog(huge),
      })
      expect(warnSpy).not.toHaveBeenCalledWith("Codex app-server stderr", expect.anything())

      // The forwarded value is bounded, not the raw multi-KB chunk.
      const forwarded = (
        debugSpy.mock.calls.find((c) => c[0] === "Codex app-server stderr")?.[1] as {
          data: string
        }
      ).data
      expect(forwarded.length).toBeLessThan(huge.length)
      expect(forwarded).toContain("chars truncated")
    } finally {
      debugSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it("ignores stderr emitted for a different agentId", async () => {
    const debugSpy = jest.spyOn(loggers.agent, "debug").mockImplementation(() => {})
    try {
      await connectedAdapter()
      stderrCb!({ agentId: "other-proc", data: "noise" })
      expect(debugSpy).not.toHaveBeenCalledWith("Codex app-server stderr", expect.anything())
    } finally {
      debugSpy.mockRestore()
    }
  })
})
