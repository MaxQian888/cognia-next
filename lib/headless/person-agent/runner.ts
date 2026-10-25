/**
 * One sandboxed agent process per member conversation (P6e, plan §9b.5).
 *
 * A turn in a member's agent conversation runs here, in their person brain:
 *
 * 1. **Lease.** `person_agent_lease_prepare` mints a task lease against the
 *    org's credential for the agent's model family. The member never sees the
 *    key; the agent gets only the lease token and the task envelope. The Host
 *    keeps the lease alive for exactly as long as the process lives.
 * 2. **Spawn.** The shared ExternalAgentManager connects the catalog runtime
 *    through the person plane (`./process-plane.ts`), which rewrites the spawn
 *    to the person contract. The Host places it in gVisor, mounts only the
 *    member's personal workspace at `/workspace`, and writes the broker config.
 * 3. **Stream.** Events become the assistant message's parts with the same
 *    projector the desktop uses, persisted at most once a second and once more
 *    when the turn settles. The same parts reach the member's devices live as
 *    `transcript://live` frames, at most every 100 ms
 *    (`lib/chat/transcript/live-frames.ts`).
 * 4. **Decide.** Tool permissions are granted: the sandbox is the boundary
 *    (no egress, only the personal workspace, only the gateway reachable).
 *    Elicitations and interactive questions are declined; a member device
 *    cannot answer them in a partition.
 *
 * The process stays up between turns, so the agent keeps its own session and
 * workspace context, and is reaped after {@link PERSON_AGENT_IDLE_MS} idle, on
 * a model or agent change, and when the Host stops it. A fresh process for a
 * conversation that already has history gets that history once, rendered as
 * text, because the previous process's native session went with its sandbox.
 */

import type {
  ExternalAgentEvent,
  ExternalAgentImageContent,
  ExternalAgentConfig,
} from "@/types/agent/external-agent"
import type { UIMessage } from "ai"
import type { ChatSession, SendContent } from "@cognia/agent-config-types"
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type { PersonProcessPlane } from "./process-plane"
import {
  createTranscriptLiveEncoder,
  TRANSCRIPT_LIVE_INTERVAL_MS,
  type TranscriptLiveFrame,
} from "@/lib/chat/transcript/live-frames"

/** How long a member's agent process may sit idle before it is stopped. */
export const PERSON_AGENT_IDLE_MS = 15 * 60_000
/** Where the Host mounts the member's personal workspace inside the sandbox. */
export const PERSON_AGENT_WORKSPACE = "/workspace"
const PERSIST_INTERVAL_MS = 1_000

type Part = UIMessage["parts"][number]

export interface PersonAgentLease {
  ticketId: string
  secret: string
  expiresAtMs: number
}

export interface PersonAgentTurnRequest {
  session: Pick<ChatSession, "id">
  runtimeId: string
  provider: string
  model: string
  prompt: SendContent
  /** The HostState action that asked for this turn. */
  actionId: string
  /** The member's message this turn answers; never part of its replayed history. */
  messageId: string
}

export type PersonAgentSettleOutcome = "completed" | "no_response" | "failed" | "cancelled"

/** The manager surface the runner drives. */
export interface PersonAgentManager {
  addAgent(config: ExternalAgentConfig): Promise<unknown>
  removeAgent(agentId: string): Promise<void>
  executeStreaming(
    agentId: string,
    prompt: string,
    options: {
      sessionId?: string
      workingDirectory: string
      attachments?: ExternalAgentImageContent[]
      context?: { custom: Record<string, unknown> }
    }
  ): AsyncIterable<ExternalAgentEvent>
  cancel(agentId: string, sessionId: string): Promise<void>
  respondToPermission(
    agentId: string,
    sessionId: string,
    response: { requestId: string; granted: boolean; optionId?: string; reason?: string }
  ): Promise<void>
  respondToElicitation(
    agentId: string,
    response: { requestId: string; action: "decline" | "cancel" }
  ): Promise<void>
}

export interface PersonAgentRunnerDeps {
  plane: PersonProcessPlane
  manager: PersonAgentManager
  /** `person_agent_lease_prepare`. */
  prepareLease(input: {
    runtimeId: string
    provider: string
    model: string
    sessionId: string
  }): Promise<PersonAgentLease>
  /** Catalog launch for a runtime id, or `undefined` when it is not bundled. */
  launchFor(runtimeId: string): { config: ExternalAgentConfig; family: string } | undefined
  /** Earlier turns of a conversation as text, for a fresh process. */
  history(sessionId: string, excludeMessageIds: readonly string[]): Promise<string>
  writeMessage(sessionId: string, message: UIMessage): Promise<void>
  /** Seal the HostState turn's work submission (`hoststate:<actionId>`). */
  settle(
    actionId: string,
    input: {
      outcome: PersonAgentSettleOutcome
      errorCode?: string
      writeTranscript?: () => Promise<void>
    }
  ): Promise<void>
  /** Feed a runtime observation into HostState. */
  project(envelope: AgentEventEnvelope): Promise<void>
  /** Send a live reply frame to the member's devices; best effort. */
  publishLive(frame: TranscriptLiveFrame): Promise<void>
  /** The conversation's persisted transcript revision, when known. */
  transcriptRevision(sessionId: string): Promise<number | undefined>
  applyEvent(parts: readonly Part[], event: ExternalAgentEvent): Part[]
  pickAllowOption(options: unknown): string | undefined
  newId(): string
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(level: "info" | "warn" | "error", message: string): void
}

/** A refusal raised before the turn was handed off; the caller settles it. */
export class PersonAgentTurnError extends Error {
  readonly code: string
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = "PersonAgentTurnError"
    this.code = code
  }
}

interface LiveAgent {
  agentId: string
  runtimeId: string
  provider: string
  model: string
  nativeSessionId?: string
  /** True until the first turn, which carries the conversation's history. */
  fresh: boolean
  dead: boolean
  idle?: unknown
  turn?: ActiveTurn
}

interface ActiveTurn {
  actionId: string
  aborted: boolean
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && code ? code : undefined
}

/** Split a prompt into the text and images an external agent takes. */
export function personAgentPrompt(prompt: SendContent): {
  text: string
  attachments: ExternalAgentImageContent[]
} {
  if (typeof prompt === "string") return { text: prompt, attachments: [] }
  const text: string[] = []
  const attachments: ExternalAgentImageContent[] = []
  for (const block of prompt) {
    if (block.type === "text") text.push(block.text)
    else if (block.type === "image")
      attachments.push({
        type: "image",
        source: { type: "base64", data: block.source.data, mediaType: block.source.media_type },
      })
    // A document has no prompt slot in an external agent, and a partition
    // has no file plane to drop it into the workspace with.
    else throw new PersonAgentTurnError("person_agent_attachment_unsupported", block.type)
  }
  return { text: text.join("\n\n"), attachments }
}

export interface PersonAgentRunner {
  /**
   * Start a turn. Resolves once the agent is running and the prompt is on
   * its way, or once the message is queued behind the conversation's running
   * turn; everything after that settles through `deps.settle`. Rejects with a
   * {@link PersonAgentTurnError} (or the Host's coded error) when the turn
   * never started, and the caller settles it.
   */
  startTurn(request: PersonAgentTurnRequest): Promise<void>
  /** Ask the running turn to stop. `false` when nothing is running. */
  abort(sessionId: string): Promise<boolean>
  /** Stop the conversation's process now (deleted conversation, shutdown). */
  close(sessionId: string): Promise<void>
  closeAll(): Promise<void>
  /** The conversation's live process, for tests and diagnostics. */
  liveAgent(sessionId: string): { agentId: string; runtimeId: string; model: string } | undefined
}

export function createPersonAgentRunner(deps: PersonAgentRunnerDeps): PersonAgentRunner {
  const live = new Map<string, LiveAgent>()
  const starting = new Map<string, Promise<LiveAgent>>()
  /** Settles when the session's last started or queued turn has settled. */
  const tails = new Map<string, Promise<void>>()

  deps.plane.onStopped((agentId) => {
    for (const [sessionId, agent] of live) {
      if (agent.agentId !== agentId || agent.dead) continue
      // The stream of an in-flight turn ends on its own (the adapter sees the
      // exit); this only makes sure the next turn starts a new process.
      agent.dead = true
      if (!agent.turn) void close(sessionId)
    }
  })

  const envelope = (
    sessionId: string,
    turnId: string,
    sequence: number,
    event: AgentEventEnvelope["event"]
  ): AgentEventEnvelope => ({
    schemaVersion: 1,
    eventId: `person-agent:${turnId}:${sequence}`,
    sequence,
    sessionId,
    runId: turnId,
    turnId,
    attemptId: turnId,
    hostRef: "person-agent",
    runtime: "external-agent",
    timestamp: new Date(deps.now()).toISOString(),
    event,
  })

  const project = async (value: AgentEventEnvelope) => {
    try {
      await deps.project(value)
    } catch (error) {
      deps.log("warn", `person agent HostState projection failed: ${String(error)}`)
    }
  }

  async function close(sessionId: string): Promise<void> {
    const agent = live.get(sessionId)
    if (!agent) return
    live.delete(sessionId)
    if (agent.idle !== undefined) deps.clearTimer(agent.idle)
    try {
      await deps.manager.removeAgent(agent.agentId)
    } catch (error) {
      deps.log("warn", `person agent ${agent.agentId} teardown failed: ${String(error)}`)
    } finally {
      deps.plane.release(agent.agentId)
    }
  }

  async function launch(request: PersonAgentTurnRequest): Promise<LiveAgent> {
    const launchSpec = deps.launchFor(request.runtimeId)
    if (!launchSpec) throw new PersonAgentTurnError("org_agent_not_allowed", request.runtimeId)
    const agentId = `person-agent-${deps.newId()}`
    const lease = await deps.prepareLease({
      runtimeId: request.runtimeId,
      provider: request.provider,
      model: request.model,
      sessionId: agentId,
    })
    const { config, family } = launchSpec
    const process = config.process!
    deps.plane.register(agentId, {
      runtimeId: request.runtimeId,
      command: process.command,
      args: process.args ?? [],
    })
    const agentConfig: ExternalAgentConfig = {
      ...config,
      id: agentId,
      enabled: true,
      process: {
        ...process,
        cwd: PERSON_AGENT_WORKSPACE,
        env: {
          COGNIA_GATEWAY_TOKEN: lease.secret,
          COGNIA_GATEWAY_TASK_CONFIG: JSON.stringify({ taskId: agentId, runtime: family }),
        },
      },
    }
    try {
      await deps.manager.addAgent(agentConfig)
    } catch (error) {
      try {
        await deps.manager.removeAgent(agentId)
      } catch {
        // Registration failed before the manager knew the agent.
      }
      deps.plane.release(agentId)
      throw error
    }
    return {
      agentId,
      runtimeId: request.runtimeId,
      provider: request.provider,
      model: request.model,
      fresh: true,
      dead: false,
    }
  }

  async function agentFor(request: PersonAgentTurnRequest): Promise<LiveAgent> {
    const sessionId = request.session.id
    const pending = starting.get(sessionId)
    if (pending) await pending.catch(() => undefined)
    const current = live.get(sessionId)
    // `startTurn` queues behind a running turn; reaching here with one is a bug.
    if (current?.turn) throw new PersonAgentTurnError("host_state_turn_running")
    if (
      current &&
      !current.dead &&
      current.runtimeId === request.runtimeId &&
      current.provider === request.provider &&
      current.model === request.model
    ) {
      if (current.idle !== undefined) deps.clearTimer(current.idle)
      current.idle = undefined
      return current
    }
    // A different agent or model is a different lease: a new process.
    if (current) await close(sessionId)
    const started = launch(request)
    starting.set(sessionId, started)
    try {
      const agent = await started
      live.set(sessionId, agent)
      return agent
    } finally {
      if (starting.get(sessionId) === started) starting.delete(sessionId)
    }
  }

  function armIdle(sessionId: string, agent: LiveAgent) {
    if (agent.idle !== undefined) deps.clearTimer(agent.idle)
    agent.idle = deps.setTimer(() => {
      if (live.get(sessionId) === agent && !agent.turn) void close(sessionId)
    }, PERSON_AGENT_IDLE_MS)
  }

  async function runTurn(
    request: PersonAgentTurnRequest,
    agent: LiveAgent,
    stream: AsyncIterator<ExternalAgentEvent>,
    turn: ActiveTurn
  ): Promise<void> {
    const sessionId = request.session.id
    const turnId = `${request.actionId}`
    let sequence = 3
    let parts: Part[] = []
    let dirty = false
    let lastWrite = 0
    let writing: Promise<void> = Promise.resolve()
    const message = (): UIMessage => ({
      id: `assistant-${request.actionId}`,
      role: "assistant",
      parts,
    })
    const flush = () => {
      if (!dirty) return writing
      dirty = false
      lastWrite = deps.now()
      const snapshot = message()
      writing = writing
        .then(() => deps.writeMessage(sessionId, snapshot))
        .catch((error) =>
          deps.log("warn", `person agent transcript write failed: ${String(error)}`)
        )
      return writing
    }
    const liveReply = createTranscriptLiveEncoder({
      sessionId,
      messageId: message().id,
      replyTo: request.messageId,
      now: deps.now,
    })
    let lastLive = Number.NEGATIVE_INFINITY
    let liveTimer: unknown
    let liveSending: Promise<void> = Promise.resolve()
    const sendLive = (frame: TranscriptLiveFrame | null) => {
      if (!frame) return liveSending
      liveSending = liveSending
        .then(() => deps.publishLive(frame))
        .catch((error) => deps.log("warn", `person agent live frame failed: ${String(error)}`))
      return liveSending
    }
    const emitLive = () => {
      liveTimer = undefined
      lastLive = deps.now()
      void sendLive(liveReply.next(parts))
    }
    const scheduleLive = () => {
      if (liveTimer !== undefined) return
      const wait = TRANSCRIPT_LIVE_INTERVAL_MS - (deps.now() - lastLive)
      if (wait <= 0) emitLive()
      else liveTimer = deps.setTimer(emitLive, wait)
    }
    let outcome: PersonAgentSettleOutcome = "failed"
    let errorCode: string | undefined
    try {
      let result = await stream.next()
      while (!result.done) {
        const event = result.value
        if (event.sessionId) agent.nativeSessionId = event.sessionId
        const nativeSession = event.sessionId ?? agent.nativeSessionId ?? ""
        if (event.type === "permission_request") {
          await deps.manager.respondToPermission(agent.agentId, nativeSession, {
            requestId: event.request.requestId ?? event.request.id,
            granted: true,
            optionId: deps.pickAllowOption(event.request.options),
            reason: "granted inside the member's sandbox",
          })
        } else if (event.type === "elicitation_request") {
          await deps.manager.respondToElicitation(agent.agentId, {
            requestId: event.request.id,
            action: "decline",
          })
        } else if (event.type === "async_questions" && event.requestId) {
          await deps.manager.respondToPermission(agent.agentId, nativeSession, {
            requestId: event.requestId,
            granted: false,
            reason: "questions cannot be answered in a member conversation",
          })
        } else if (event.type === "done") {
          outcome = turn.aborted || event.stopReason === "cancelled" ? "cancelled" : "completed"
          if (!event.success && outcome === "completed") {
            outcome = "failed"
            errorCode = "turn_error"
          }
        } else if (event.type === "error") {
          outcome = "failed"
          errorCode = event.code ?? "turn_error"
        }
        const next = deps.applyEvent(parts, event)
        if (next !== parts) {
          parts = next
          dirty = true
          if (deps.now() - lastWrite >= PERSIST_INTERVAL_MS) void flush()
          scheduleLive()
        }
        result = await stream.next()
      }
      if (outcome === "completed" && parts.length === 0) outcome = "no_response"
    } catch (error) {
      outcome = turn.aborted ? "cancelled" : "failed"
      errorCode = turn.aborted ? undefined : (codeOf(error) ?? "turn_error")
      deps.log("warn", `person agent turn ${turnId} ended: ${String(error)}`)
    }
    // The Host's own reason wins: a quota or standing stop is what happened,
    // whatever the adapter made of the exit.
    const hostReason = deps.plane.stopReason(agent.agentId)
    if (hostReason) {
      outcome = "failed"
      errorCode = hostReason
    } else if (agent.dead && outcome === "failed" && errorCode === "turn_error") {
      errorCode = "person_agent_exited"
    }
    agent.turn = undefined
    if (liveTimer !== undefined) deps.clearTimer(liveTimer)
    liveTimer = undefined
    await writing
    // The final frame goes before the final transcript write and names the
    // revision persisted so far: a device keeps drawing the finished reply
    // until its timeline reads past it, i.e. has the final write.
    if (parts.length > 0) {
      const persisted = await deps.transcriptRevision(sessionId).catch(() => undefined)
      await sendLive(liveReply.next(parts, "settled", persisted))
    } else {
      await sendLive(liveReply.reset())
    }
    const final = message()
    await deps.settle(request.actionId, {
      outcome,
      ...(outcome === "failed" ? { errorCode: errorCode ?? "turn_error" } : {}),
      ...(parts.length > 0 ? { writeTranscript: () => deps.writeMessage(sessionId, final) } : {}),
    })
    await project(
      envelope(
        sessionId,
        turnId,
        sequence++,
        outcome === "failed"
          ? {
              kind: "failure",
              code: errorCode ?? "turn_error",
              message: errorCode ?? "turn_error",
              retryable: false,
            }
          : { kind: "lifecycle", phase: outcome === "cancelled" ? "interrupted" : "ended" }
      )
    )
    if (agent.dead || hostReason) await close(sessionId)
    else if (live.get(sessionId) === agent) armIdle(sessionId, agent)
  }

  function track(sessionId: string, settled: Promise<void>) {
    const tail = settled.catch((error) =>
      deps.log("error", `person agent turn could not settle: ${String(error)}`)
    )
    tails.set(sessionId, tail)
    void tail.finally(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId)
    })
  }

  /**
   * Start one turn: resolves once the prompt is streaming, carrying the
   * promise of its settlement. Throws when it never started; nothing is settled then.
   */
  async function begin(
    request: PersonAgentTurnRequest,
    prompt: ReturnType<typeof personAgentPrompt>,
    accepted: boolean
  ): Promise<{ settled: Promise<void> }> {
    const sessionId = request.session.id
    const agent = await agentFor(request)
    const turn: ActiveTurn = { actionId: request.actionId, aborted: false }
    agent.turn = turn
    let stream: AsyncIterator<ExternalAgentEvent>
    try {
      const history = agent.fresh
        ? await deps.history(sessionId, [request.messageId, `assistant-${request.actionId}`])
        : ""
      agent.fresh = false
      stream = deps.manager
        .executeStreaming(agent.agentId, prompt.text, {
          ...(agent.nativeSessionId ? { sessionId: agent.nativeSessionId } : {}),
          workingDirectory: PERSON_AGENT_WORKSPACE,
          ...(prompt.attachments.length > 0 ? { attachments: prompt.attachments } : {}),
          ...(history ? { context: { custom: { conversationHistory: history } } } : {}),
        })
        [Symbol.asyncIterator]()
    } catch (error) {
      agent.turn = undefined
      armIdle(sessionId, agent)
      throw error
    }
    const turnId = request.actionId
    for (const [sequence, phase] of [
      [0, "accepted"],
      [1, "delivered"],
    ] as const) {
      if (phase === "accepted" && accepted) continue
      await project(
        envelope(sessionId, turnId, sequence, {
          kind: "queue",
          phase,
          queueId: request.actionId,
          delivery: "after-settle",
        })
      )
    }
    await project(envelope(sessionId, turnId, 2, { kind: "lifecycle", phase: "started" }))
    // Wrapped: an async function would otherwise flatten the settlement into
    // its own result and hold the dispatcher for the whole turn.
    return { settled: runTurn(request, agent, stream, turn) }
  }

  return {
    async startTurn(request) {
      const sessionId = request.session.id
      const prompt = personAgentPrompt(request.prompt)
      const previous = tails.get(sessionId)
      if (!previous) {
        track(sessionId, (await begin(request, prompt, false)).settled)
        return
      }
      // A turn is running: this message waits for it, as the sidecar's own
      // queue does, and is delivered when that turn settles.
      await project(
        envelope(sessionId, request.actionId, 0, {
          kind: "queue",
          phase: "accepted",
          queueId: request.actionId,
          delivery: "after-settle",
        })
      )
      track(
        sessionId,
        previous.then(async () => {
          try {
            await (
              await begin(request, prompt, true)
            ).settled
          } catch (error) {
            const code = codeOf(error) ?? "turn_error"
            await deps.settle(request.actionId, { outcome: "failed", errorCode: code })
            await project(
              envelope(sessionId, request.actionId, 1, {
                kind: "queue",
                phase: "dropped",
                queueId: request.actionId,
                delivery: "after-settle",
                reason: code,
              })
            )
          }
        })
      )
    },

    async abort(sessionId) {
      const agent = live.get(sessionId)
      if (!agent?.turn) return false
      agent.turn.aborted = true
      if (agent.nativeSessionId) {
        await deps.manager.cancel(agent.agentId, agent.nativeSessionId)
      } else {
        // The prompt has not reached a session yet; stopping the process is
        // the only way to stop it.
        agent.dead = true
        await deps.manager.removeAgent(agent.agentId).catch(() => undefined)
      }
      return true
    },

    close,

    async closeAll() {
      await Promise.all([...live.keys()].map((sessionId) => close(sessionId)))
    },

    liveAgent(sessionId) {
      const agent = live.get(sessionId)
      return agent
        ? { agentId: agent.agentId, runtimeId: agent.runtimeId, model: agent.model }
        : undefined
    },
  }
}
