/**
 * The room runner against fakes: no store, no Dexie, no React (ADR-0177).
 *
 * The sidecar is a scripted fake. `sendPrompt` on a member sub-session
 * schedules that member's reply as the same three frames the real sidecar
 * emits (an assistant message, a result, `session_ended`), fed back through
 * `handleEvent`, so the orchestration below runs the same event path the
 * desktop and the headless brain run.
 */

import type { UIMessage } from "ai"
import type {
  ChatSession,
  Character,
  ClaudeEvent,
  SendContent,
  SendOptions,
  Team,
} from "@cognia/agent-config-types"
import type { CogniaDiagnostic } from "@cognia/diagnostics"
import type { ChatStatus, SteerEntry } from "@/stores/chat"
import type { MemberStatus } from "@/stores/ui"

jest.mock("@/lib/claude/adapter", () => {
  type Msg = { id: string; role: string; parts: unknown[]; metadata?: Record<string, unknown> }
  let userSeq = 0
  const identity = (messages: Msg[]) => messages
  return {
    applySdkEvent: (
      messages: Msg[],
      evt: { type: string; message?: { id: string; text: string } }
    ) => {
      if (evt.type === "assistant" && evt.message) {
        const next: Msg = {
          id: evt.message.id,
          role: "assistant",
          parts: [{ type: "text", text: evt.message.text }],
        }
        const idx = messages.findIndex((m) => m.id === next.id)
        const out =
          idx >= 0
            ? messages.map((m, i) => (i === idx ? { ...next, metadata: m.metadata } : m))
            : [...messages, next]
        return { messages: out, turnComplete: false }
      }
      if (evt.type === "result") {
        return { messages: messages.map((m) => m), turnComplete: true, result: evt }
      }
      // A tool call starting on the member's newest reply, the part shape
      // the real adapter paints on `content_block_start` (state, no output).
      const tool = evt as { type: string; name?: string; input?: Record<string, unknown> }
      if (tool.type === "tool_start" && tool.name) {
        let idx = -1
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]!.role === "assistant") {
            idx = i
            break
          }
        }
        if (idx < 0) return { messages, turnComplete: false }
        const target = messages[idx]!
        const part = {
          type: `tool-${tool.name}`,
          toolCallId: `tu-${tool.name}`,
          state: "input-available",
          input: tool.input ?? {},
        }
        const out = messages.map((m, i) =>
          i === idx ? { ...target, parts: [...target.parts, part] } : m
        )
        return { messages: out, turnComplete: false }
      }
      return { messages, turnComplete: false }
    },
    makeUserMessage: (content: SendContent, _id?: string, manifest?: unknown) => ({
      id: `u-${++userSeq}`,
      role: "user",
      parts:
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : content.map((b) => (b.type === "text" ? { type: "text", text: b.text } : b)),
      ...(manifest ? { metadata: { attachmentManifest: manifest } } : {}),
    }),
    mergeAgentKnowledgeSourcesIntoLastAssistant: identity,
    mergeMemorySourcesIntoLastAssistant: identity,
    mergeProjectClaimSourcesIntoLastAssistant: identity,
    mergeProjectHistorySourcesIntoLastAssistant: identity,
    mergeProjectKnowledgeSourcesIntoLastAssistant: identity,
    mergeTwinSourcesIntoLastAssistant: identity,
    mergeWebSearchSourcesIntoLastAssistant: identity,
  }
})
jest.mock("@/lib/ai/generation/run-title-task", () => ({
  shouldGenerateTitle: () => false,
  isPlaceholderTitle: () => false,
}))
jest.mock("@/lib/rag/chat-grounding", () => ({
  attachInteractiveGrounding: (messages: unknown) => messages,
}))
jest.mock("@/lib/claude/team-primary-router", () => ({
  ...jest.requireActual("@/lib/claude/team-primary-router"),
  // No utility model in the world: the sticky member, else nobody, which is
  // what lets the routing tests below see the runner's own inputs.
  selectPrimaryResponder: async ({ sticky }: { sticky?: { id: string } }) => sticky,
}))

import {
  ACTIVITY_STALE_MS,
  RoomRunner,
  TYPING_POLL_MS,
  TYPING_WINDOW_MS,
  TYPING_YIELD_MAX_MS,
  asPlainText,
  withMetadata,
} from "./runner"
import type { RoomRunnerDeps, RoomRunnerSinks } from "./runner-deps"
import { decodeSubSession } from "@/lib/claude/team-session-id"

type Msg = UIMessage & { metadata?: Record<string, unknown> }

const ROOM = "room-1"
const AVA: Character = { id: "a", name: "Ava" } as Character
const BEE: Character = { id: "b", name: "Bee" } as Character

const assistantFrame = (sub: string, id: string, text: string): ClaudeEvent =>
  ({ type: "event", sessionId: sub, event: { type: "assistant", message: { id, text } } }) as never
const resultFrame = (sub: string): ClaudeEvent =>
  ({
    type: "event",
    sessionId: sub,
    event: { type: "result", subtype: "success", duration_ms: 5 },
  }) as never
const toolStartFrame = (sub: string, name: string, input: Record<string, unknown>): ClaudeEvent =>
  ({ type: "event", sessionId: sub, event: { type: "tool_start", name, input } }) as never
const endedFrame = (sub: string, error: string | null = null): ClaudeEvent =>
  ({ type: "session_ended", sessionId: sub, error }) as never
const permissionFrame = (sub: string, toolName = "Bash"): ClaudeEvent =>
  ({
    type: "permission_request",
    sessionId: sub,
    requestId: "req-1",
    toolUseID: "tu-1",
    toolName,
    input: { command: "ls" },
  }) as never

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

type Script = (sub: string, emit: (evt: ClaudeEvent) => void) => void

function createWorld(init: { session?: Partial<ChatSession>; team?: Partial<Team> } = {}) {
  let replySeq = 0
  const scripts = new Map<string, Script>()
  const defaultScript: Script = (sub, emit) => {
    const name = decodeSubSession(sub)?.characterId === "a" ? "Ava" : "Bee"
    emit(assistantFrame(sub, `r-${++replySeq}`, `${name} says hi`))
    emit(resultFrame(sub))
    emit(endedFrame(sub))
  }
  const replyWith = (characterId: string, text: string) =>
    scripts.set(characterId, (sub, emit) => {
      emit(assistantFrame(sub, `r-${++replySeq}`, text))
      emit(resultFrame(sub))
      emit(endedFrame(sub))
    })

  const db = new Map<string, Msg[]>()
  const store = new Map<string, Msg[]>()
  const open = new Set<string>([ROOM])
  const status = new Map<string, ChatStatus>()
  const statusLog: string[] = []
  const memberStatus = new Map<string, MemberStatus>()
  const memberActivity = new Map<string, string>()
  const activityLog: string[] = []
  const stopRequests = new Set<string>()
  const diagnostics: CogniaDiagnostic[] = []
  const approvals: unknown[] = []
  const steerQueues = new Map<string, SteerEntry[]>()
  const steerAppended: Msg[] = []
  const drained: string[] = []
  const armed = new Set<string>()
  const typedAt = new Map<string, number>()
  let humanProbe: (() => number | null) | null = null
  let clockOffset = 0
  let sleeps = 0
  const calls = {
    sendPrompt: [] as {
      sub: string
      content: SendContent
      options: SendOptions
      /** How many rows the room held when this member was started. */
      rowsAtStart: number
    }[],
    interrupt: [] as string[],
    close: [] as string[],
    approve: [] as unknown[][],
    bumpUnread: [] as string[],
    usage: [] as unknown[],
    commits: 0,
    updateSession: [] as unknown[],
    alwaysAllowToggled: [] as [string, boolean][],
  }
  const session: ChatSession = {
    id: ROOM,
    kind: "team",
    teamId: "team-1",
    title: "Room",
    ...init.session,
  } as ChatSession
  const team: Team = {
    id: "team-1",
    name: "Duo",
    orchestration: "round_robin",
    members: [{ characterId: "a" }, { characterId: "b", role: "Researcher" }],
    maxAutoRounds: 0,
    ...init.team,
  } as Team
  let alwaysAllow: string[] = []
  const routeRemote = jest.fn(() => false)
  const tryBuildMemoryDeps = jest.fn(async () => undefined)
  const runTurnMemory = jest.fn(async () => undefined)
  let turn = 0

  const ref: { runner: RoomRunner | null } = { runner: null }
  const emit = (evt: ClaudeEvent) => ref.runner?.handleEvent(evt)

  const deps: RoomRunnerDeps = {
    ipc: {
      sendPrompt: async (sub, content, options) => {
        calls.sendPrompt.push({
          sub,
          content,
          options: options ?? {},
          rowsAtStart: (db.get(ROOM) ?? []).length,
        })
        const characterId = decodeSubSession(sub)?.characterId ?? ""
        const script = scripts.get(characterId) ?? defaultScript
        setTimeout(() => script(sub, emit), 0)
      },
      interruptSession: async (sub) => {
        calls.interrupt.push(sub)
      },
      closeSession: async (sub) => {
        calls.close.push(sub)
      },
      approveTool: async (...args) => {
        calls.approve.push(args)
      },
    },
    db: {
      getSession: async (id) => (id === ROOM ? session : undefined),
      updateSession: async (id, patch) => {
        calls.updateSession.push({ id, patch })
      },
      touchSession: async () => undefined,
      getTeam: async (id) => (id === team.id ? team : undefined),
      listCharactersByIds: async (ids) => [AVA, BEE].filter((c) => ids.includes(c.id)),
      listMessages: async (id) => [...(db.get(id) ?? [])],
      persistMessages: async (id, messages) => {
        db.set(id, [...(messages as Msg[])])
      },
      bumpUnread: async (id) => {
        calls.bumpUnread.push(id)
      },
      recordResultUsage: async (input) => {
        calls.usage.push(input)
      },
    },
    execution: {
      isAtCapacity: () => false,
      runWithExecutionLease: (_request, run) => run(),
      acquireChatLease: async () => undefined,
      slotKeyForTurn: () => undefined,
      resolveEffectiveCwdForSession: async () => null,
    },
    ai: {
      resolveSendOptions: async () => ({ systemPrompt: "sys", model: "m", provider: "p" }),
      tryBuildTwinDeps: async () => undefined,
      tryBuildMemoryDeps,
      generateSafeEmbedding: async () => ({ embedding: [] }),
      runTurnMemory,
      buildUtilityLlmClient: () => null,
      runTitleTask: async () => undefined,
      resolveProviderAttemptOptions: async () => ({}),
      pendingRecoveryPhase: () => null,
      applySdkSubagentBridge: () => undefined,
      recordChatToolApprovalDecision: async () => undefined,
    },
    now: () => 1_000 + turn + clockOffset,
    newTurnId: () => `t${++turn}`,
    persistDelayMs: 0,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps += 1
      clockOffset += ms
    },
  }
  const sinks: RoomRunnerSinks = {
    status: {
      get: (id) => status.get(id) ?? "idle",
      set: (id, next) => {
        status.set(id, next)
        statusLog.push(`status:${next}`)
      },
      setError: (id, error) => {
        statusLog.push(`error:${error}`)
        if (error === null) status.set(id, "idle")
      },
    },
    diagnostic: (_id, diagnostic) => {
      diagnostics.push(diagnostic)
    },
    messages: {
      read: (id) => (open.has(id) ? store.get(id) : undefined),
      commit: (id, messages) => {
        calls.commits += 1
        store.set(id, messages as Msg[])
      },
      setActiveBranch: () => undefined,
      isOpen: (id) => open.has(id),
    },
    steer: {
      queue: (id) => steerQueues.get(id) ?? [],
      enqueue: (id, entry) => steerQueues.set(id, [...(steerQueues.get(id) ?? []), entry]),
      clear: (id) => steerQueues.delete(id),
      appendMessage: (_id, message) => {
        steerAppended.push(message as Msg)
      },
      drain: (id) => {
        drained.push(id)
      },
      armed,
    },
    members: {
      setStatus: (id, characterId, next) => memberStatus.set(`${id}::${characterId}`, next),
      setActivity: (id, characterId, activity) => {
        activityLog.push(`${characterId}:${activity ?? "-"}`)
        if (activity === null) memberActivity.delete(`${id}::${characterId}`)
        else memberActivity.set(`${id}::${characterId}`, activity)
      },
      clearFor: (id) => {
        for (const key of [...memberStatus.keys()])
          if (key.startsWith(`${id}::`)) memberStatus.delete(key)
        for (const key of [...memberActivity.keys()])
          if (key.startsWith(`${id}::`)) memberActivity.delete(key)
      },
      requestStop: (id, characterId) => {
        stopRequests.add(`${id}::${characterId}`)
      },
      isStopRequested: (id, characterId) => stopRequests.has(`${id}::${characterId}`),
      clearStopRequest: (id, characterId) => stopRequests.delete(`${id}::${characterId}`),
      clearStopRequestsFor: (id) => {
        for (const key of [...stopRequests]) if (key.startsWith(`${id}::`)) stopRequests.delete(key)
      },
    },
    approvals: {
      push: (approval) => {
        approvals.push(approval)
      },
      clear: () => undefined,
      routeRemote,
    },
    settings: {
      read: () => ({ alwaysAllowTools: alwaysAllow }) as never,
      alwaysAllowTools: () => alwaysAllow,
      toggleAlwaysAllow: async (tool, on) => {
        calls.alwaysAllowToggled.push([tool, on])
      },
    },
    referencedPaths: () => [],
    human: { lastTypedAt: (id) => (humanProbe ? humanProbe() : (typedAt.get(id) ?? null)) },
  }
  const runner = new RoomRunner(deps, sinks)
  ref.runner = runner

  return {
    runner,
    deps,
    sinks,
    emit,
    calls,
    db,
    store,
    open,
    status,
    statusLog,
    memberStatus,
    memberActivity,
    activityLog,
    stopRequests,
    diagnostics,
    approvals,
    steerQueues,
    steerAppended,
    drained,
    armed,
    routeRemote,
    tryBuildMemoryDeps,
    runTurnMemory,
    replyWith,
    scripts,
    setAlwaysAllow: (tools: string[]) => {
      alwaysAllow = tools
    },
    seed: (messages: Msg[]) => {
      db.set(ROOM, [...messages])
      store.set(ROOM, [...messages])
    },
    typedAt,
    setHumanProbe: (probe: () => number | null) => {
      humanProbe = probe
    },
    now: () => deps.now(),
    sleeps: () => sleeps,
  }
}

const textOf = (m: Msg) =>
  m.parts
    .filter((p): p is { type: "text"; text: string } => (p as { type: string }).type === "text")
    .map((p) => p.text)
    .join("")

describe("a linear turn", () => {
  it("retries a member with the selected fallback model and recomputed execution limits", async () => {
    const w = createWorld({ team: { members: [{ characterId: "a" }] } })
    w.deps.ai.resolveSendOptions = async () =>
      ({
        provider: "initial",
        model: "initial-model",
        modelParams: { maxOutputTokens: 256 },
        compaction: { enabled: true, contextWindow: 200000 },
        routingPlan: {
          decisionId: "retry",
          orderedCandidates: [
            { providerId: "initial", modelId: "initial-model" },
            { providerId: "next", modelId: "fallback-model" },
          ],
        },
      }) as never
    const resolveAttempt = jest.fn(async () => ({
      modelParams: { maxOutputTokens: 256 },
      compaction: { enabled: true, contextWindow: 32000 } as SendOptions["compaction"],
    }))
    w.deps.ai.resolveProviderAttemptOptions = resolveAttempt
    let attempts = 0
    w.scripts.set("a", (sub, emit) => {
      if (attempts++ === 0) emit(endedFrame(sub, "rate limit exceeded"))
      else {
        emit(assistantFrame(sub, "retried", "success"))
        emit(resultFrame(sub))
        emit(endedFrame(sub))
      }
    })
    await w.runner.send("hello", { sessionId: ROOM })
    expect(resolveAttempt).toHaveBeenCalledWith(
      "next",
      expect.anything(),
      "fallback-model",
      expect.objectContaining({
        modelParams: { maxOutputTokens: 256 },
        compaction: { enabled: true, contextWindow: 200000 },
      })
    )
    expect(w.calls.sendPrompt[1].options).toMatchObject({
      provider: "next",
      model: "fallback-model",
      modelParams: { maxOutputTokens: 256 },
      compaction: { enabled: true, contextWindow: 32000 },
    })
  })

  it("runs every target one after another and persists the room transcript", async () => {
    const w = createWorld()
    await w.runner.send("hello team", { sessionId: ROOM })

    // One sub-session per member, in the team's declared order, on one turn id.
    expect(w.calls.sendPrompt.map((c) => decodeSubSession(c.sub)?.characterId)).toEqual(["a", "b"])
    expect(new Set(w.calls.sendPrompt.map((c) => c.sub.split("::").at(-1))).size).toBe(1)
    expect(w.calls.close).toEqual(w.calls.sendPrompt.map((c) => c.sub))

    const persisted = w.db.get(ROOM) ?? []
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant", "assistant"])
    expect(persisted[0].metadata).toMatchObject({ senderKind: "user" })
    expect(persisted[1].metadata).toMatchObject({ senderId: "a" })
    expect(persisted[2].metadata).toMatchObject({ senderId: "b" })
    expect(textOf(persisted[2])).toBe("Bee says hi")
    // The open pane sees the same list.
    expect(w.store.get(ROOM)).toEqual(persisted)
    expect(w.status.get(ROOM)).toBe("idle")
    expect([...w.memberStatus.values()]).toEqual([])
  })

  it("clears a stale error before the room goes streaming, so the status is not stranded", async () => {
    const w = createWorld()
    await w.runner.send("go", { sessionId: ROOM })
    expect(w.statusLog.slice(0, 2)).toEqual(["error:null", "status:streaming"])
    expect(w.statusLog[w.statusLog.length - 1]).toBe("status:idle")
  })

  it("gives every member the shared system prompt plus the room instructions", async () => {
    const w = createWorld({
      session: { roomSettings: { instructions: "Answer in one line." } },
    })
    await w.runner.send("go", { sessionId: ROOM })
    for (const call of w.calls.sendPrompt) {
      expect(call.options.systemPrompt).toContain("sys")
      expect(call.options.systemPrompt).toContain("## Room instructions\n\nAnswer in one line.")
    }
  })

  it("preserves template provenance on persisted and queued user turns", async () => {
    const w = createWorld()
    const templateRun = {
      templateId: "review",
      version: "1",
      text: "Review {{target}}",
      params: { target: { kind: "text" as const, value: "workflow" } },
    }
    await w.runner.send("Review workflow", { sessionId: ROOM, templateRun })
    expect(w.db.get(ROOM)?.[0].metadata).toMatchObject({ templateRun })
    w.status.set(ROOM, "streaming")
    await w.runner.send("Review workflow", { sessionId: ROOM, templateRun })
    expect(w.steerAppended.at(-1)?.metadata).toMatchObject({ templateRun })
  })

  it("stamps the reply reference on the user turn and on a queued steer", async () => {
    const w = createWorld()
    const replyTo = { messageId: "m-earlier", preview: "the plan" }
    await w.runner.send("answering", { sessionId: ROOM, replyTo })
    expect(w.db.get(ROOM)?.[0].metadata).toEqual({ senderKind: "user", replyTo })
    // While the room streams, the same option lands on the steer entry and the
    // optimistic row, so the drained turn still answers the right message.
    w.status.set(ROOM, "streaming")
    await w.runner.send("and this", { sessionId: ROOM, replyTo })
    expect(w.steerQueues.get(ROOM)?.[0]).toMatchObject({ text: "and this", replyTo })
    expect(w.steerAppended.at(-1)?.metadata).toMatchObject({ replyTo })
  })

  it("stamps the author a companion turn arrived with", async () => {
    const w = createWorld()
    await w.runner.send("from my phone", {
      sessionId: ROOM,
      author: { kind: "human", id: "usr_1", displayName: "Pixel", source: "device:dev-1" },
    })
    expect(w.db.get(ROOM)?.[0].metadata).toEqual({
      senderKind: "user",
      collaboration: {
        author: { kind: "human", id: "usr_1", displayName: "Pixel", source: "device:dev-1" },
      },
    })
  })

  it("skips a member the user asked to stop mid-turn and keeps going with the rest", async () => {
    const w = createWorld({ team: { members: [{ characterId: "a" }, { characterId: "b" }] } })
    // A stop request that predates the turn is stale and cleared on send; one
    // raised while the first member speaks must take the second one out.
    w.stopRequests.add(`${ROOM}::b`)
    w.scripts.set("a", (sub, emit) => {
      w.stopRequests.add(`${ROOM}::b`)
      emit(assistantFrame(sub, "r-a", "Ava says hi"))
      emit(resultFrame(sub))
      emit(endedFrame(sub))
    })
    await w.runner.send("go", { sessionId: ROOM })
    expect(w.calls.sendPrompt.map((c) => decodeSubSession(c.sub)?.characterId)).toEqual(["a"])
    expect(w.stopRequests.has(`${ROOM}::b`)).toBe(false)
    expect(w.memberStatus.size).toBe(0)
  })

  it("reports a member that errored and still lets the next one speak", async () => {
    const w = createWorld()
    w.scripts.set("a", (sub, emit) => emit(endedFrame(sub, "provider exploded")))
    await w.runner.send("go", { sessionId: ROOM })
    expect(w.calls.sendPrompt.map((c) => decodeSubSession(c.sub)?.characterId)).toEqual(["a", "b"])
    expect(w.diagnostics.map((d) => d.meta?.extra)).toContainEqual(
      expect.objectContaining({ characterId: "a", memberName: "Ava" })
    )
    expect(w.db.get(ROOM)?.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("refuses a session that is not a team room", async () => {
    const w = createWorld({ session: { kind: undefined, teamId: undefined } as never })
    await w.runner.send("go", { sessionId: ROOM })
    expect(w.diagnostics.map((d) => d.code)).toEqual(["teamSessionMissing"])
    expect(w.calls.sendPrompt).toEqual([])
  })

  it("does nothing in manual mode until the user picks a member", async () => {
    const w = createWorld({ team: { orchestration: "manual" } })
    await w.runner.send("go", { sessionId: ROOM })
    expect(w.calls.sendPrompt).toEqual([])
    expect(w.status.get(ROOM)).toBe("idle")
    expect(w.db.get(ROOM)?.map((m) => m.role)).toEqual(["user"])
  })
})

describe("memory in a room", () => {
  it("reads and writes long-term memory by default", async () => {
    const w = createWorld()
    await w.runner.send("remember this", { sessionId: ROOM })
    expect(w.tryBuildMemoryDeps).toHaveBeenCalled()
    expect(w.runTurnMemory).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ userText: "remember this", assistantText: "Bee says hi" })
    )
  })

  it("never builds the read deps nor distils when the room switched memory off", async () => {
    const w = createWorld({ session: { roomSettings: { memory: false } } })
    await w.runner.send("remember this", { sessionId: ROOM })
    expect(w.tryBuildMemoryDeps).not.toHaveBeenCalled()
    expect(w.runTurnMemory).not.toHaveBeenCalled()
  })
})

describe("handoff rounds", () => {
  it("lets a mentioned teammate take the floor and stops quietly when nobody hands off", async () => {
    const w = createWorld({ team: { orchestration: "mention_round_robin", maxAutoRounds: 3 } })
    w.replyWith("a", "@Bee can you check the numbers?")
    await w.runner.send("@Ava start", { sessionId: ROOM })
    expect(w.calls.sendPrompt.map((c) => decodeSubSession(c.sub)?.characterId)).toEqual(["a", "b"])
    expect(w.diagnostics).toEqual([])
  })

  it("says so when the round budget cut the conversation off", async () => {
    const w = createWorld({ team: { orchestration: "mention_round_robin", maxAutoRounds: 1 } })
    w.replyWith("a", "@Bee can you check the numbers?")
    w.replyWith("b", "@Ava the numbers hold, over to you")
    await w.runner.send("@Ava start", { sessionId: ROOM })
    expect(w.calls.sendPrompt.map((c) => decodeSubSession(c.sub)?.characterId)).toEqual(["a", "b"])
    expect(w.diagnostics.map((d) => [d.code, d.meta?.extra])).toEqual([
      ["handoffChainCapped", { stop: "budget" }],
    ])
  })

  it("ends the chain on the stop token and strips it from the stored reply", async () => {
    const w = createWorld({ team: { orchestration: "mention_round_robin", maxAutoRounds: 3 } })
    w.replyWith("a", "@Bee all done here <stop-handoff/>")
    await w.runner.send("@Ava start", { sessionId: ROOM })
    expect(w.calls.sendPrompt.map((c) => decodeSubSession(c.sub)?.characterId)).toEqual(["a"])
    expect(textOf(w.db.get(ROOM)![1])).toBe("@Bee all done here")
    expect(w.diagnostics).toEqual([])
  })
})

describe("stopping and steering", () => {
  it("interrupts the running member and issues no further sub-sessions", async () => {
    const w = createWorld()
    w.scripts.set("a", () => undefined)
    const turn = w.runner.send("go", { sessionId: ROOM })
    await flush()
    expect(w.calls.sendPrompt).toHaveLength(1)
    await w.runner.stop(ROOM)
    await turn
    expect(w.calls.interrupt).toEqual([w.calls.sendPrompt[0].sub])
    expect(w.calls.sendPrompt).toHaveLength(1)
    expect(w.status.get(ROOM)).toBe("idle")
    expect(w.drained).toEqual([])
  })

  it("queues a turn typed while the room is streaming instead of orchestrating twice", async () => {
    const w = createWorld()
    w.status.set(ROOM, "streaming")
    await w.runner.send("and also this", { sessionId: ROOM, webSearchContext: { q: 1 } as never })
    expect(w.calls.sendPrompt).toEqual([])
    expect(w.steerQueues.get(ROOM)).toEqual([
      expect.objectContaining({ text: "and also this", webSearchContext: { q: 1 } }),
    ])
    expect(w.steerAppended[0].metadata).toMatchObject({
      senderKind: "user",
      steer: { state: "queued" },
    })
  })

  it("replays the queued steer once a clean turn settles", async () => {
    const w = createWorld()
    await w.runner.send("go", { sessionId: ROOM })
    expect(w.drained).toEqual([ROOM])
  })

  it("arms the steer and cuts the turn short on interruptAndSteer", async () => {
    const w = createWorld()
    w.scripts.set("a", () => undefined)
    w.steerQueues.set(ROOM, [{ id: "s1", text: "wait" }] as SteerEntry[])
    const turn = w.runner.send("go", { sessionId: ROOM })
    await flush()
    await w.runner.interruptAndSteer(ROOM)
    await turn
    expect(w.calls.interrupt).toHaveLength(1)
    // An interrupted turn still drains because the steer was armed.
    expect(w.drained).toEqual([ROOM])
  })

  it("does not interrupt when there is nothing queued", async () => {
    const w = createWorld()
    await w.runner.interruptAndSteer(ROOM)
    expect(w.calls.interrupt).toEqual([])
    w.runner.flushSteer(ROOM)
    expect(w.drained).toEqual([ROOM])
  })
})

describe("regenerate and edit", () => {
  it("re-issues the last user turn and files the old reply as a branch", async () => {
    const w = createWorld({ team: { members: [{ characterId: "a" }] } })
    w.seed([
      { id: "u-0", role: "user", parts: [{ type: "text", text: "first" }] } as Msg,
      {
        id: "r-0",
        role: "assistant",
        parts: [{ type: "text", text: "old" }],
        metadata: { senderId: "a" },
      } as Msg,
    ])
    await w.runner.regenerate(ROOM)
    expect(w.calls.sendPrompt).toHaveLength(1)
    expect(w.calls.sendPrompt[0].content).toBe("first")
    const messages = w.db.get(ROOM)!
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1)
    const [old, fresh] = messages.filter((m) => m.role === "assistant")
    expect(old.metadata?.branchGroupId).toBeDefined()
    expect(fresh.metadata).toMatchObject({
      senderId: "a",
      branchGroupId: old.metadata?.branchGroupId,
      branchIndex: 1,
    })
  })

  it("does nothing when there is no user turn to regenerate", async () => {
    const w = createWorld()
    await w.runner.regenerate(ROOM)
    expect(w.calls.sendPrompt).toEqual([])
  })

  it("edits a user message into a sibling branch and re-runs the room below it", async () => {
    const w = createWorld({ team: { members: [{ characterId: "a" }] } })
    w.seed([{ id: "u-0", role: "user", parts: [{ type: "text", text: "typo" }] } as Msg])
    await w.runner.editAndResend(ROOM, "u-0", "fixed")
    expect(w.calls.sendPrompt[0].content).toBe("fixed")
    const users = w.db.get(ROOM)!.filter((m) => m.role === "user")
    expect(users).toHaveLength(2)
    expect(users[1].metadata).toMatchObject({
      branchGroupId: users[0].metadata?.branchGroupId,
      branchIndex: 1,
    })
  })
})

describe("streaming several members at once", () => {
  const SUB_A = `${ROOM}::char::a::t9`
  const SUB_B = `${ROOM}::char::b::t9`

  it("keeps each member's partial output out of the other's base and folds both", async () => {
    const w = createWorld()
    w.seed([{ id: "u-0", role: "user", parts: [{ type: "text", text: "go" }] } as Msg])
    w.emit(assistantFrame(SUB_A, "a1", "A partial"))
    w.emit(assistantFrame(SUB_B, "b1", "B partial"))
    await flush()
    expect(w.store.get(ROOM)?.map((m) => m.id)).toEqual(["u-0", "a1", "b1"])
    expect(w.store.get(ROOM)?.[1].metadata).toMatchObject({ senderId: "a" })
    expect(w.store.get(ROOM)?.[2].metadata).toMatchObject({ senderId: "b" })

    w.emit(assistantFrame(SUB_A, "a1", "A final"))
    w.emit(resultFrame(SUB_A))
    await flush()
    expect(w.db.get(ROOM)?.map((m) => [m.id, textOf(m)])).toEqual([
      ["u-0", "go"],
      ["a1", "A final"],
      ["b1", "B partial"],
    ])

    w.emit(resultFrame(SUB_B))
    await flush()
    expect(w.db.get(ROOM)?.map((m) => m.id)).toEqual(["u-0", "a1", "b1"])
  })

  it("records usage against the member whose reply arrived with the result", async () => {
    const w = createWorld()
    w.seed([{ id: "u-0", role: "user", parts: [{ type: "text", text: "go" }] } as Msg])
    w.emit(assistantFrame(SUB_A, "a1", "A"))
    w.emit(resultFrame(SUB_A))
    await flush()
    // The reply was already in the view when the result came, so no new
    // assistant row is attributed: usage rides on the message the result
    // itself introduces, never on a re-count of an earlier frame.
    expect(w.calls.usage).toEqual([])
  })

  it("bumps unread and skips the store for a room with no open pane", async () => {
    const w = createWorld()
    w.open.clear()
    w.seed([{ id: "u-0", role: "user", parts: [{ type: "text", text: "go" }] } as Msg])
    w.emit(assistantFrame(SUB_A, "a1", "A"))
    await flush()
    expect(w.calls.bumpUnread).toEqual([ROOM])
    expect(w.calls.commits).toBe(0)
    w.emit(resultFrame(SUB_A))
    await flush()
    expect(w.db.get(ROOM)?.map((m) => m.id)).toEqual(["u-0", "a1"])
    expect(w.calls.commits).toBe(0)
  })

  it("ignores events that do not belong to a room member", async () => {
    const w = createWorld()
    w.emit(assistantFrame("direct-chat", "x", "y"))
    await flush()
    expect(w.calls.commits).toBe(0)
    expect(w.db.has("direct-chat")).toBe(false)
  })
})

describe("tool approvals", () => {
  const SUB_A = `${ROOM}::char::a::t9`

  it("surfaces a member's ask on an open room, naming the member", async () => {
    const w = createWorld()
    w.emit(permissionFrame(SUB_A))
    await flush()
    expect(w.approvals).toEqual([
      expect.objectContaining({
        sessionId: SUB_A,
        requestId: "req-1",
        toolName: "Bash",
        description: "From a",
      }),
    ])
    expect(w.calls.approve).toEqual([])
  })

  it("auto-approves a tool the user always allows", async () => {
    const w = createWorld()
    w.setAlwaysAllow(["Bash"])
    w.emit(permissionFrame(SUB_A))
    await flush()
    expect(w.calls.approve).toEqual([
      [SUB_A, "req-1", "allow", undefined, undefined, undefined, { authority: "policy-rule" }],
    ])
    expect(w.approvals).toEqual([])
  })

  it("denies on a closed room nobody is attached to", async () => {
    const w = createWorld()
    w.open.clear()
    w.emit(permissionFrame(SUB_A))
    await flush()
    expect(w.routeRemote).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ requestId: "req-1" }),
      expect.any(Function)
    )
    expect(w.calls.approve).toEqual([
      [
        SUB_A,
        "req-1",
        "deny",
        "auto-denied: session not open",
        undefined,
        undefined,
        { authority: "system" },
      ],
    ])
  })

  it("waits for the attached device instead of denying when the lease says so", async () => {
    const w = createWorld()
    w.open.clear()
    w.routeRemote.mockReturnValue(true)
    w.emit(permissionFrame(SUB_A))
    await flush()
    expect(w.calls.approve).toEqual([])
    expect(w.approvals).toEqual([])
  })

  it("answers on the member sub-session and remembers allow_always", async () => {
    const w = createWorld()
    const approval = { sessionId: SUB_A, requestId: "req-1", toolName: "Bash" } as never
    await w.runner.respondToApproval(approval, "allow_always")
    expect(w.calls.alwaysAllowToggled).toEqual([["Bash", true]])
    expect(w.calls.approve).toEqual([[SUB_A, "req-1", "allow"]])
    await w.runner.respondToApproval(approval, "deny")
    expect(w.calls.approve[1]).toEqual([SUB_A, "req-1", "deny"])
  })
})

describe("helpers", () => {
  it("merges metadata without dropping what was there", () => {
    const msg = { id: "m", role: "user", parts: [], metadata: { a: 1 } } as unknown as UIMessage
    expect((withMetadata(msg, { b: 2 }) as Msg).metadata).toEqual({ a: 1, b: 2 })
  })

  it("flattens content blocks to their text", () => {
    expect(asPlainText("hi")).toBe("hi")
    expect(
      asPlainText([
        { type: "text", text: "a" },
        { type: "image", source: {} } as never,
        { type: "text", text: "b" },
      ])
    ).toBe("a b")
  })
})

describe("member activity (ADR-0177 batch 2)", () => {
  const SUB_A = `${ROOM}::char::a::t9`
  const SUB_B = `${ROOM}::char::b::t9`

  it("names the tool a member is on from its own slice and clears it when the member ends", async () => {
    const w = createWorld()
    w.seed([{ id: "u-0", role: "user", parts: [{ type: "text", text: "go" }] } as Msg])
    w.emit(assistantFrame(SUB_A, "a1", ""))
    w.emit(toolStartFrame(SUB_A, "Read", { file_path: "/repo/runner.ts" }))
    await flush()
    expect(w.memberActivity.get(`${ROOM}::a`)).toBe("Read · runner.ts")
    // Another member's frames never touch a's label.
    w.emit(assistantFrame(SUB_B, "b1", "hello"))
    await flush()
    expect(w.memberActivity.get(`${ROOM}::a`)).toBe("Read · runner.ts")
    expect(w.memberActivity.has(`${ROOM}::b`)).toBe(false)
    w.emit(endedFrame(SUB_A))
    await flush()
    expect(w.memberActivity.has(`${ROOM}::a`)).toBe(false)
    expect(w.activityLog).toEqual(["a:Read · runner.ts", "a:-"])
  })

  it("drops a label whose tool never reported back after the stale window", async () => {
    jest.useFakeTimers()
    try {
      const w = createWorld()
      w.seed([{ id: "u-0", role: "user", parts: [{ type: "text", text: "go" }] } as Msg])
      w.emit(assistantFrame(SUB_A, "a1", ""))
      w.emit(toolStartFrame(SUB_A, "Bash", { command: "sleep 999" }))
      await jest.advanceTimersByTimeAsync(10)
      expect(w.memberActivity.get(`${ROOM}::a`)).toBe("Bash · sleep 999")
      await jest.advanceTimersByTimeAsync(ACTIVITY_STALE_MS + 1)
      expect(w.memberActivity.has(`${ROOM}::a`)).toBe(false)
      w.runner.dispose()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("room settings steer the turn (ADR-0177 batch 3)", () => {
  const speakers = (w: ReturnType<typeof createWorld>) =>
    w.calls.sendPrompt.map((c) => decodeSubSession(c.sub)?.characterId)

  it("never picks a muted member on its own, but a mention still reaches it", async () => {
    const w = createWorld({ session: { roomSettings: { mutedMemberIds: ["b"] } } })
    await w.runner.send("hello", { sessionId: ROOM })
    expect(speakers(w)).toEqual(["a"])
    await w.runner.send("@Bee you too", { sessionId: ROOM })
    expect(speakers(w)).toEqual(["a", "b"])
  })

  it("reaches exactly the members the composer picked, above mute and reply mode", async () => {
    const w = createWorld({
      session: { roomSettings: { mutedMemberIds: ["b"], replyMode: "mention_only" } },
    })
    await w.runner.send("go", { sessionId: ROOM, targetMemberIds: ["b"] })
    expect(speakers(w)).toEqual(["b"])
    expect(w.db.get(ROOM)?.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("stores the turn and stays quiet when the room is asleep or nobody was mentioned", async () => {
    const asleep = createWorld({ session: { roomSettings: { replyMode: "asleep" } } })
    await asleep.runner.send("@Ava anyone?", { sessionId: ROOM })
    expect(asleep.calls.sendPrompt).toEqual([])
    expect(asleep.db.get(ROOM)?.map((m) => m.role)).toEqual(["user"])
    expect(asleep.status.get(ROOM)).toBe("idle")

    const quiet = createWorld({ session: { roomSettings: { replyMode: "mention_only" } } })
    await quiet.runner.send("anyone?", { sessionId: ROOM })
    expect(quiet.calls.sendPrompt).toEqual([])
    await quiet.runner.send("@Bee?", { sessionId: ROOM })
    expect(speakers(quiet)).toEqual(["b"])
  })

  it("keeps the last speaker for an unaddressed follow-up", async () => {
    const w = createWorld({ team: { orchestration: "mention_round_robin" } })
    await w.runner.send("@Bee start", { sessionId: ROOM })
    await w.runner.send("and then?", { sessionId: ROOM })
    expect(speakers(w)).toEqual(["b", "b"])
    // A muted last speaker is not sticky: the room falls back to the roster.
    const muted = createWorld({
      team: { orchestration: "mention_round_robin" },
      session: { roomSettings: { mutedMemberIds: ["b"] } },
    })
    await muted.runner.send("@Bee start", { sessionId: ROOM })
    await muted.runner.send("and then?", { sessionId: ROOM })
    expect(speakers(muted)).toEqual(["b", "a"])
  })

  it("drops a handoff outside the speaker's declared targets and tells the member so", async () => {
    const w = createWorld({
      team: {
        orchestration: "mention_round_robin",
        maxAutoRounds: 3,
        members: [{ characterId: "a", handoffTargets: [] }, { characterId: "b" }],
      },
    })
    w.replyWith("a", "@Bee can you check the numbers?")
    await w.runner.send("@Ava start", { sessionId: ROOM })
    expect(speakers(w)).toEqual(["a"])
    expect(w.calls.sendPrompt[0]?.options.systemPrompt).toContain(
      "not able to hand the floor to anyone"
    )
    expect(w.diagnostics).toEqual([])
  })

  it("lets a talkative member chime in on an auto round", async () => {
    const w = createWorld({
      team: {
        orchestration: "mention_round_robin",
        maxAutoRounds: 1,
        members: [{ characterId: "a" }, { characterId: "b", talkativeness: 0.9 }],
      },
    })
    await w.runner.send("@Ava start", { sessionId: ROOM })
    // The world rolls 0.5, under Bee's 0.9, so Bee speaks up once.
    expect(speakers(w)).toEqual(["a", "b"])
    expect(w.diagnostics).toEqual([])
  })

  it("runs the round's members at once when the team says parallel", async () => {
    const sequential = createWorld()
    await sequential.runner.send("go", { sessionId: ROOM })
    expect(sequential.calls.sendPrompt.map((c) => c.rowsAtStart)).toEqual([1, 2])

    const parallel = createWorld({ team: { replyConcurrency: "parallel" } })
    await parallel.runner.send("go", { sessionId: ROOM })
    expect(parallel.calls.sendPrompt.map((c) => c.rowsAtStart)).toEqual([1, 1])
    const persisted = parallel.db.get(ROOM) ?? []
    expect(persisted.map((m) => m.metadata?.senderId)).toEqual([undefined, "a", "b"])
    expect(parallel.status.get(ROOM)).toBe("idle")
  })

  it("stops one member and lets the rest of the round go on", async () => {
    const w = createWorld()
    w.scripts.set("a", () => undefined)
    const turn = w.runner.send("go", { sessionId: ROOM })
    await flush()
    expect(speakers(w)).toEqual(["a"])
    await w.runner.stopMember(ROOM, "a")
    await turn
    expect(w.calls.interrupt).toEqual([w.calls.sendPrompt[0]!.sub])
    expect(speakers(w)).toEqual(["a", "b"])
    expect(w.diagnostics).toEqual([])
    expect(w.memberStatus.get(`${ROOM}::a`)).toBeUndefined()
    expect(w.db.get(ROOM)?.map((m) => m.metadata?.senderId)).toEqual([undefined, "b"])
  })

  it("skips a member stopped while an earlier one was still replying", async () => {
    const w = createWorld()
    w.scripts.set("a", (sub, emit) => {
      setTimeout(() => {
        emit(assistantFrame(sub, "r-slow", "Ava says hi"))
        emit(resultFrame(sub))
        emit(endedFrame(sub))
      }, 20)
    })
    const turn = w.runner.send("go", { sessionId: ROOM })
    await flush()
    await w.runner.stopMember(ROOM, "b")
    await turn
    expect(speakers(w)).toEqual(["a"])
    expect(w.calls.interrupt).toEqual([])
    expect(w.stopRequests.size).toBe(0)
  })

  it("waits for the human to finish typing before the next auto round", async () => {
    const w = createWorld({ team: { orchestration: "mention_round_robin", maxAutoRounds: 3 } })
    w.replyWith("a", "@Bee your turn")
    w.typedAt.set(ROOM, 1_000)
    await w.runner.send("@Ava start", { sessionId: ROOM })
    expect(speakers(w)).toEqual(["a", "b"])
    expect(w.sleeps()).toBe(Math.ceil(TYPING_WINDOW_MS / TYPING_POLL_MS))
  })

  it("gives up waiting after the ceiling so a parked draft cannot stall the room", async () => {
    const w = createWorld({ team: { orchestration: "mention_round_robin", maxAutoRounds: 3 } })
    w.replyWith("a", "@Bee your turn")
    // Every poll sees a keystroke that just happened.
    w.setHumanProbe(() => w.now())
    await w.runner.send("@Ava start", { sessionId: ROOM })
    expect(speakers(w)).toEqual(["a", "b"])
    expect(w.sleeps()).toBeLessThanOrEqual(Math.ceil(TYPING_YIELD_MAX_MS / TYPING_POLL_MS) + 1)
    expect(w.sleeps()).toBeGreaterThan(Math.ceil(TYPING_WINDOW_MS / TYPING_POLL_MS))
  })

  it("stands down from the auto rounds once the human sent something", async () => {
    const w = createWorld({ team: { orchestration: "mention_round_robin", maxAutoRounds: 3 } })
    w.replyWith("a", "@Bee your turn")
    w.steerQueues.set(ROOM, [{ id: "s1", text: "actually, stop" }] as SteerEntry[])
    await w.runner.send("@Ava start", { sessionId: ROOM })
    expect(speakers(w)).toEqual(["a"])
    expect(w.sleeps()).toBe(0)
    expect(w.drained).toEqual([ROOM])
  })
})
