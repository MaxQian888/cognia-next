import type { ExternalAgentConfig, ExternalAgentMessage } from "@/types/agent/external-agent"

// ----------------------------------------------------------------------------
// Mocks: stdio native bridge + env builder + isTauri
// ----------------------------------------------------------------------------

let stdoutCb: ((event: { agentId: string; data: string }) => void) | undefined
let exitCb: ((event: { agentId: string; code: number }) => void) | undefined
const writes: string[] = []
const responders: Record<string, (msg: { id: number; params?: unknown }) => unknown> = {}

function autoRespond(agentId: string, message: string): void {
  const msg = JSON.parse(message)
  if (typeof msg.id === "number" && typeof msg.method === "string") {
    const responder = responders[msg.method]
    const result = responder ? responder(msg) : {}
    queueMicrotask(() => stdoutCb?.({ agentId, data: JSON.stringify({ id: msg.id, result }) }))
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
  onExternalAgentStderr: jest.fn(async () => () => {}),
  onExternalAgentExit: jest.fn(async (cb: (e: { agentId: string; code: number }) => void) => {
    exitCb = cb
    return () => {
      exitCb = undefined
    }
  }),
}))

import { CodexAppServerAdapter } from "./codex-app-server-client"

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
  })

  describe("session extension support", () => {
    it("reports session list/fork/resume as deterministically unsupported", async () => {
      const adapter = await connectedAdapter()
      const support = adapter.getSessionExtensionSupport()
      expect(support["session/list"].state).toBe("unsupported")
      expect(support["session/fork"].state).toBe("unsupported")
      expect(support["session/resume"].state).toBe("unsupported")
      expect(support["session/resume"].reason).toMatch(/does not implement/i)
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

    it("answers item/tool/requestUserInput gracefully and surfaces the question", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({ permissionMode: "default" })
      const it = iterator(adapter, session.id, userMessage("ask me"))
      const first = it.next()
      feedServerRequest(70, "item/tool/requestUserInput", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "q-item",
        questions: [{ id: "q1", header: "Region", question: "Which region?" }],
      })
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      const texts: string[] = []
      let r = await first
      while (!r.done) {
        if (r.value.type === "message_delta") {
          texts.push((r.value as { delta: { text: string } }).delta.text)
        }
        r = await it.next()
      }
      // The turn was NOT broken with a method-not-found error.
      const reply = lastWritten((m) => m.id === 70 && m.result !== undefined)
      expect(reply?.result).toEqual({ answers: { q1: { answers: [] } } })
      expect(lastWritten((m) => m.id === 70 && m.error !== undefined)).toBeUndefined()
      expect(texts.join("")).toContain("Which region?")
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

    it("prepends a brief-aware system prompt as the first input on the first turn", async () => {
      const adapter = await connectedAdapter()
      const session = await adapter.createSession({
        systemPrompt: "You are a release bot.",
        briefMode: true,
      })
      const it = iterator(adapter, session.id, userMessage("ship it"))
      const first = it.next()
      feed("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } })
      let r = await first
      while (!r.done) r = await it.next()

      const turn = lastWritten((m) => m.method === "turn/start")!
      const input = (turn.params as { input: Array<{ type: string; text?: string }> }).input
      expect(input[0].text).toContain("Respond concisely")
      expect(input[0].text).toContain("You are a release bot.")
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
