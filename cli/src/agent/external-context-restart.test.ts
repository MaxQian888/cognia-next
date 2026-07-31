/**
 * @jest-environment node
 *
 * Phase 5 — which layer a changed setting lands in on an external backend.
 *
 * The interesting cases are all "did the external protocol session get
 * recreated, and did the user hear about it": ACP bakes instructions, roots and
 * the tool surface into `session/new`, so continuing a session across a change
 * would leave the agent obeying settings the TUI already shows as changed.
 */
import type { SendOptions } from "@cognia/agent-config-types"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type {
  ExternalAgentExecutionOptions,
  ExternalAgentResult,
} from "@/types/agent/external-agent"

import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import {
  createExternalAgentSession,
  type ExternalAgentSessionManager,
} from "./external-agent-session"
import { createCliContextAssembler } from "./session-context"
import { CONTEXT_RESTART_NOTICE } from "../tui/runtime/context-lifecycle"
import type { ToolHostBroker } from "./tool-host/broker"
import type { TranscriptFs } from "./transcript"
import type { TuiAction } from "../tui/state/types"

const HOME = "/home/u/.cognia"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS, git: true },
  providers: { anthropic: { apiKey: "sk" } },
  cwd: "/work",
  agentBackend: "claude-code",
}

function memoryTranscript(seed: Record<string, string> = {}) {
  const written: Record<string, string> = { ...seed }
  const fs: TranscriptFs = {
    append: () => undefined,
    read: (p) => written[p] ?? null,
    mkdirp: () => undefined,
    write: (p, content) => {
      written[p] = content
    },
  }
  return { fs, written }
}

function fakeManager() {
  const sessionIds: (string | undefined)[] = []
  let turn = 0
  const manager: ExternalAgentSessionManager = {
    addAgent: jest.fn(async () => undefined),
    execute: jest.fn(async (_agentId, _prompt, options?: ExternalAgentExecutionOptions) => {
      sessionIds.push(options?.sessionId)
      turn += 1
      return {
        success: true,
        sessionId: `acp-${turn}`,
        finalResponse: "ok",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      } as ExternalAgentResult
    }),
    setSessionMode: jest.fn(async () => undefined),
    setSessionModel: jest.fn(async () => undefined),
    cancel: jest.fn(async () => undefined),
    removeAgent: jest.fn(async () => undefined),
  }
  return { manager, sessionIds }
}

/** Assembler whose resolved prompt is swapped between turns by the test. */
function mutableAssembler(promptRef: { value: string }) {
  return createCliContextAssembler({
    config,
    sessionId: "s1",
    home: HOME,
    now: () => 1_700_000_000_000,
    resolveOptions: async () =>
      ({ systemPrompt: promptRef.value, builtinTools: config.builtinTools }) as SendOptions,
    buildContent: (prompt: string) => ({
      content: prompt,
      imageCount: 0,
      documentCount: 0,
      injectedFiles: [],
      ocr: [],
      failed: [],
      skipped: [],
    }),
    resolveMcpServers: () => [],
    resolveSkillIds: () => [],
    resolveLoadableSkills: async () => [],
    resolveDisabledMcpTools: () => new Set<string>(),
    ensureDb: async () => undefined,
    resolveApprovedTools: () => new Set<string>(),
    loadPluginRuntime: async () => undefined,
    resolveAgents: async () => [],
    resolveAgentMode: async () => null,
    fetchTwin: async () => null,
  })
}

function fakeBroker() {
  const closed: number[] = []
  let attempts = 0
  return {
    closed,
    attempts: () => attempts,
    start: async ({ attempt }: { attempt: number }) => {
      attempts += 1
      return {
        endpoint: `/tmp/a-${attempt}.sock`,
        token: `t-${attempt}`,
        attempt,
        connections: () => 0,
        isClosed: () => false,
        cancelInFlight: () => undefined,
        close: async () => {
          closed.push(attempt)
        },
      } as unknown as ToolHostBroker
    },
  }
}

function build(seed: Record<string, string> = {}) {
  const promptRef = { value: "PROMPT A" }
  const { manager, sessionIds } = fakeManager()
  const transcript = memoryTranscript(seed)
  const host = fakeBroker()
  const actions: TuiAction[] = []
  const session = createExternalAgentSession({
    config,
    manager,
    home: HOME,
    sessionId: "s1",
    transcriptFs: transcript.fs,
    assembler: mutableAssembler(promptRef),
    startToolHost: host.start as never,
    buildToolHostServers: () => [] as never,
  })
  const send = (prompt: string) =>
    session.send(prompt, {
      gate: async () => ({ decision: "allow" }),
      onAction: (action) => actions.push(action),
    })
  return { session, send, promptRef, manager, sessionIds, transcript, host, actions }
}

describe("session-layer changes recreate the external protocol session", () => {
  it("continues the same agent session while the context is unchanged", async () => {
    const { send, sessionIds, actions } = build()
    await send("one")
    await send("two")
    expect(sessionIds).toEqual([undefined, "acp-1"])
    expect(actions.filter((a) => a.type === "NOTICE")).toHaveLength(0)
  })

  it("starts a new agent session — with one notice — after a prompt change", async () => {
    const { send, promptRef, session, sessionIds, actions, manager } = build()
    await send("one")
    promptRef.value = "PROMPT B"
    session.invalidateOptions?.()
    await send("two")
    // The second turn carries NO session id: the agent starts fresh.
    expect(sessionIds).toEqual([undefined, undefined])
    expect(manager.cancel).toHaveBeenCalledWith("cli-external-s1", "acp-1")
    expect(actions.filter((a) => a.type === "NOTICE")).toEqual([
      { type: "NOTICE", message: CONTEXT_RESTART_NOTICE },
    ])
  })

  it("rebuilds the tool host so a bridge never outlives the context it was minted for", async () => {
    const { send, promptRef, session, host } = build()
    await send("one")
    expect(host.attempts()).toBe(1)
    promptRef.value = "PROMPT B"
    session.invalidateOptions?.()
    await send("two")
    expect(host.attempts()).toBe(2)
    expect(host.closed).toEqual([1])
  })

  it("re-resolves without restarting when the context is semantically identical", async () => {
    const { send, session, sessionIds, actions } = build()
    await send("one")
    session.invalidateOptions?.()
    await send("two")
    expect(sessionIds).toEqual([undefined, "acp-1"])
    expect(actions.filter((a) => a.type === "NOTICE")).toHaveLength(0)
  })

  it("records the new link only after the replacement session exists", async () => {
    const { send, promptRef, session, transcript } = build()
    await send("one")
    const first = JSON.parse(transcript.written[`${HOME}/sessions/s1.external.json`]!) as {
      externalSessionId: string
      contextVersion: string
    }
    promptRef.value = "PROMPT B"
    session.invalidateOptions?.()
    await send("two")
    const second = JSON.parse(transcript.written[`${HOME}/sessions/s1.external.json`]!) as {
      externalSessionId: string
      contextVersion: string
    }
    expect(second.externalSessionId).toBe("acp-2")
    expect(second.contextVersion).not.toBe(first.contextVersion)
  })
})

describe("resume across a context change", () => {
  it("never resumes a session recorded under a different context version", async () => {
    const { send, sessionIds, actions } = build({
      [`${HOME}/sessions/s1.external.json`]: JSON.stringify({
        backend: "claude-code",
        externalSessionId: "acp-old",
        contextVersion: "stale",
      }),
    })
    await send("one")
    expect(sessionIds).toEqual([undefined])
    expect(actions.filter((a) => a.type === "NOTICE")).toHaveLength(1)
  })

  it("never resumes a link recorded before context versions existed", async () => {
    const { send, sessionIds } = build({
      [`${HOME}/sessions/s1.external.json`]: JSON.stringify({
        backend: "claude-code",
        externalSessionId: "acp-old",
      }),
    })
    await send("one")
    expect(sessionIds).toEqual([undefined])
  })

  it("resumes when the recorded context version still matches", async () => {
    // Resolve the version the way the session will, then seed a link with it.
    const promptRef = { value: "PROMPT A" }
    const resolved = await mutableAssembler(promptRef).resolveSession()
    const { send, sessionIds, actions } = build({
      [`${HOME}/sessions/s1.external.json`]: JSON.stringify({
        backend: "claude-code",
        externalSessionId: "acp-old",
        contextVersion: resolved.contextVersion,
      }),
    })
    await send("one")
    expect(sessionIds).toEqual(["acp-old"])
    expect(actions.filter((a) => a.type === "NOTICE")).toHaveLength(0)
  })
})

describe("live-layer changes", () => {
  it("switches permission mode on the live session without restarting it", async () => {
    const { send, session, manager, sessionIds } = build()
    await send("one")
    await session.setPermissionMode?.("plan")
    expect(manager.setSessionMode).toHaveBeenCalledWith("cli-external-s1", "acp-1", "plan")
    await send("two")
    expect(sessionIds).toEqual([undefined, "acp-1"])
  })

  it("switches the model on the live session so the thread survives a /model pick", async () => {
    const { send, session, manager } = build()
    await send("one")
    expect(await session.setModel?.("gpt-5-codex")).toBe(true)
    expect(manager.setSessionModel).toHaveBeenCalledWith("cli-external-s1", "acp-1", "gpt-5-codex")
  })
})
