/**
 * `verified-fresh-agent` orchestration (ADR-0117, deferred by ADR-0164).
 *
 * After the main agent finishes its turn, a brand-new agent with NONE of that
 * turn's context checks the result. "None" is the contract, not a mood:
 *
 *  - a NEW session, minted here, never the main one and never a reused one
 *  - no memory recall: `resolveSendOptions` only injects memory when handed
 *    `memoryDeps`, and this module never hands it any
 *  - no twin, no project-knowledge deps, no tool history: the verifier sees
 *    exactly three things, the user's request, the main turn's final reply
 *    and, when the turn ran inside a repository, the working-tree diff
 *  - read-only authority (`plan`), because a headless session has nobody to
 *    answer a permission prompt and a verifier that edits is not a verifier
 *
 * It rides the EXISTING headless executor, `runAndCaptureAssistantReply`,
 * exactly as the plugin agent-turn, the connector auto-reply and the Squad
 * runtime do. There is no second executor here, only a different input.
 *
 * Two halves. `runVerifiedFreshAgentTurn` is the turn itself, pure over
 * injected deps so the contract above is pinned by tests rather than hoped
 * for. `armVerifiedFreshAgentFollowup` is the trigger: the chat controller
 * arms it before the main send and it watches the chat store for the turn to
 * settle, which covers the SDK, standalone and external-agent paths with one
 * subscription instead of a hook in each settle site.
 *
 * ## Dormant on companion shells, on purpose
 *
 * A phone or a paired browser drives the host's chat over the companion
 * transport, but the headless capture path was never wired for that route:
 * `runAndCaptureAssistantReply` subscribes to the local event channel and
 * admits against the local execution broker, both of which describe the
 * process that owns the sidecar. Rather than let the verifier appear to run
 * and never answer, the follow-up refuses to arm there with a named reason,
 * the picker shows the option disabled with the same reason
 * (`chatOrchestrationUnavailableReason`) and `verified-fresh-agent.test.ts`
 * pins both. Removing this gate means wiring the capture path over the
 * companion transport first.
 */

import type { UIMessage } from "ai"
import type {
  ChatSession,
  SendContent,
  SendOptions,
  StoredMessage,
} from "@cognia/agent-config-types"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { HostProfile } from "@/lib/platform/capabilities"
import type { VerificationVerdict, VerificationVerdictPart } from "@/lib/claude/parts-extensions"
import { flattenMessageText } from "@/lib/claude/replay"
import { extractJson } from "@cognia/eval-core/json"
import type { WorkspaceDiffSnapshot } from "@/lib/git/workspace-diff"

// ---- Prompt -----------------------------------------------------------------

export const VERIFIER_SYSTEM_PROMPT = [
  "You are an independent verifier. Another agent has just answered a user's request.",
  "You share none of its context: you did not see its reasoning, its tool calls or its memory, and you must not assume any of it.",
  "Judge only what is in front of you: the user's request, the agent's final reply and, when present, the diff of what changed on disk.",
  "You may read files in the working directory to check claims, but you must not modify anything.",
  "Decide whether the reply actually satisfies the request. Look for claims the diff does not support, work the request asked for that is missing, and errors in what was done.",
  "Answer with ONLY a JSON object, nothing before or after it and no markdown fences:",
  '{"verdict": "pass" | "fail" | "unsure", "summary": "<one or two sentences>", "points": ["<one concrete finding per entry>"]}',
  'Use "pass" when the request is met and you found no material problem, "fail" when it is not met or you found one, and "unsure" when you cannot tell from the evidence.',
  "Keep every point specific and under 200 characters. Do not invent problems you cannot point at.",
].join("\n")

export interface VerificationPromptInput {
  request: string
  reply: string
  diff: WorkspaceDiffSnapshot | null
}

export function buildVerificationPrompt(input: VerificationPromptInput): string {
  const sections = [
    "## The user's request",
    input.request.trim() || "(empty)",
    "",
    "## The agent's final reply",
    input.reply.trim() || "(empty)",
  ]
  if (input.diff && input.diff.text) {
    const count = input.diff.fileCount
    sections.push(
      "",
      `## Working-tree diff (${count} file${count === 1 ? "" : "s"}${input.diff.truncated ? ", truncated" : ""})`,
      "```diff",
      input.diff.text,
      "```"
    )
  } else {
    sections.push("", "## Working-tree diff", "(no repository, or nothing changed)")
  }
  sections.push("", "Verify the reply against the request and answer with the JSON object.")
  return sections.join("\n")
}

// ---- Verdict parsing --------------------------------------------------------

export interface ParsedVerdict {
  verdict: VerificationVerdict
  summary: string
  points: string[]
}

const VERDICTS: readonly VerificationVerdict[] = ["pass", "fail", "unsure"]

function cleanPoints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, 20)
}

/**
 * Tolerant: a verifier that answers in plain sentences still yields an
 * `unsure` verdict carrying its text, never a throw. A missing verdict is
 * `unsure`, not `pass`, because a verifier that failed to decide must not
 * read as approval.
 */
export function parseVerificationVerdict(text: string): ParsedVerdict {
  const trimmed = text.trim()
  let parsed: unknown = null
  try {
    parsed = extractJson<unknown>(trimmed)
  } catch {
    parsed = null
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    const verdict = VERDICTS.includes(obj.verdict as VerificationVerdict)
      ? (obj.verdict as VerificationVerdict)
      : "unsure"
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
    return { verdict, summary, points: cleanPoints(obj.points) }
  }
  return { verdict: "unsure", summary: trimmed.slice(0, 600), points: [] }
}

// ---- The verification turn --------------------------------------------------

export interface VerifiedFreshAgentTurnInput {
  mainSessionId: string
  mainSessionTitle?: string
  request: string
  reply: string
  /** The main turn's effective working directory, or `null` when it had none. */
  cwd: string | null
  projectId?: string
  signal?: AbortSignal
}

/**
 * Narrow structural view of `resolveSendOptions`'s context: the fields this
 * module is allowed to set. Memory, twin and project-knowledge deps are
 * deliberately not representable here, which is how "no shared context" is
 * enforced by the type as well as by the test.
 */
export interface VerifierSendContext {
  session: ChatSession | null
  character: null
  appSettings: unknown
}

export interface VerifiedFreshAgentTurnDeps {
  createSession: (
    partial: Pick<ChatSession, "title" | "systemPrompt" | "permissionMode"> & {
      workingDir?: string
      projectId?: string
    }
  ) => Promise<{ id: string }>
  getSession: (sessionId: string) => Promise<ChatSession | undefined>
  getSettings: () => Promise<unknown>
  resolveSendOptions: (ctx: VerifierSendContext) => Promise<SendOptions>
  runAndCapture: (
    sessionId: string,
    prompt: SendContent,
    options: SendOptions,
    cap: {
      signal?: AbortSignal
      timeoutMs?: number
      execution?: {
        kind: "subagent"
        label: string
        sessionId: string
        projectId?: string
      }
    }
  ) => Promise<{
    text: string
    messageId?: string
  }>
  readDiff: (cwd: string) => Promise<WorkspaceDiffSnapshot>
  persistTranscript: (sessionId: string, messages: UIMessage[]) => Promise<void>
}

export interface VerifiedFreshAgentTurnResult {
  verificationSessionId: string
  parsed: ParsedVerdict
  diffIncluded: boolean
  rawText: string
}

export const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000

async function productionTurnDeps(): Promise<VerifiedFreshAgentTurnDeps> {
  const [sessions, settings, buildOptions, runner, messages, diff] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/lib/db/settings"),
    import("@/lib/claude/build-options"),
    import("@/lib/claude/run-and-capture"),
    import("@/lib/db/messages"),
    import("@/lib/git/workspace-diff"),
  ])
  return {
    createSession: (partial) => sessions.createSession(partial),
    getSession: (id) => sessions.getSession(id),
    getSettings: () => settings.getSettings().catch(() => undefined),
    resolveSendOptions: (ctx) =>
      buildOptions.resolveSendOptions({
        session: ctx.session,
        character: ctx.character,
        appSettings: (ctx.appSettings ?? null) as Parameters<
          typeof buildOptions.resolveSendOptions
        >[0]["appSettings"],
      }),
    runAndCapture: (sessionId, prompt, options, cap) =>
      runner.runAndCaptureAssistantReply(sessionId, prompt, options, cap),
    readDiff: (cwd) => diff.readWorkspaceDiff(cwd),
    persistTranscript: (sessionId, list) => messages.persistMessages(sessionId, list),
  }
}

export function verificationSessionTitle(mainTitle: string | undefined): string {
  const base = mainTitle?.trim()
  return base ? `Verify: ${base}` : "Verify: untitled turn"
}

/**
 * Run the verifier once and return its verdict. The verification session is
 * persisted with the exact prompt and the verifier's reply, so opening it
 * later shows what the verifier was told and what it said, and lets the user
 * continue the conversation with it.
 */
export async function runVerifiedFreshAgentTurn(
  input: VerifiedFreshAgentTurnInput,
  deps?: VerifiedFreshAgentTurnDeps
): Promise<VerifiedFreshAgentTurnResult> {
  const d = deps ?? (await productionTurnDeps())
  const cwd = input.cwd?.trim() || null

  const diff = cwd ? await d.readDiff(cwd).catch(() => null) : null
  const prompt = buildVerificationPrompt({ request: input.request, reply: input.reply, diff })

  const created = await d.createSession({
    title: verificationSessionTitle(input.mainSessionTitle),
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    permissionMode: "plan",
    ...(cwd ? { workingDir: cwd } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  })
  if (created.id === input.mainSessionId) {
    throw new Error("verified-fresh-agent: the verification session must not be the main session")
  }
  const verificationSessionId = created.id

  const [session, appSettings] = await Promise.all([
    d.getSession(verificationSessionId),
    d.getSettings(),
  ])
  const sendOptions = await d.resolveSendOptions({
    session: session ?? null,
    character: null,
    appSettings,
  })
  // Read-only, decided at THIS call site (see `lib/plugin/api/agent-turn.ts`
  // on why a headless caller must pin the mode itself). Also drop any resume
  // identity: a fresh session has none, and a stale one would be shared
  // context by the back door.
  sendOptions.permissionMode = "plan"
  delete sendOptions.resumeSessionId

  const result = await d.runAndCapture(verificationSessionId, prompt, sendOptions, {
    timeoutMs: VERIFICATION_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
    execution: {
      kind: "subagent",
      label: `Verify ${input.mainSessionId.slice(0, 8)}`,
      sessionId: verificationSessionId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
  })

  const transcript: UIMessage[] = [
    {
      id: `${verificationSessionId}:request`,
      role: "user",
      parts: [{ type: "text", text: prompt }],
    },
    {
      id: result.messageId || `${verificationSessionId}:verdict`,
      role: "assistant",
      parts: [{ type: "text", text: result.text }],
    },
  ]
  await d.persistTranscript(verificationSessionId, transcript).catch(() => undefined)

  return {
    verificationSessionId,
    parsed: parseVerificationVerdict(result.text),
    diffIncluded: Boolean(diff && diff.text),
    rawText: result.text,
  }
}

// ---- The follow-up trigger --------------------------------------------------

export type VerificationFollowupRefusal = "companionShell" | "noSession"

export interface ArmVerificationInput {
  sessionId: string
  /** The user's request as sent to the provider, without attachments. */
  request: string
  cwd: string | null
  projectId?: string
  mainSessionTitle?: string
}

interface SessionSliceView {
  messages: UIMessage[]
  status: ChatStatus
  errorDiagnostic: unknown
}

export interface VerificationFollowupStore {
  getState: () => {
    sessions: Record<string, SessionSliceView | undefined>
    replaceSessionMessages: (sessionId: string, messages: UIMessage[]) => void
  }
  subscribe: (listener: () => void) => () => void
}

export interface VerificationFollowupDeps {
  store: VerificationFollowupStore
  persist: (sessionId: string, messages: UIMessage[]) => Promise<void>
  run: (input: VerifiedFreshAgentTurnInput) => Promise<VerifiedFreshAgentTurnResult>
  hostProfile: () => HostProfile
  now: () => number
  /** Message id for the running card, minted before the verifier session exists. */
  messageId: () => string
}

export type ArmVerificationResult =
  | {
      armed: true
      settled: Promise<void>
    }
  | {
      armed: false
      reason: VerificationFollowupRefusal
    }

/** Profiles that drive a remote host: the headless capture path is not wired there. */
export const VERIFICATION_DORMANT_PROFILES: readonly HostProfile[] = [
  "mobile-companion",
  "cloud-companion",
]

export function verificationAvailableOn(profile: HostProfile): boolean {
  return !VERIFICATION_DORMANT_PROFILES.includes(profile)
}

async function productionFollowupDeps(): Promise<VerificationFollowupDeps> {
  const [{ useChatStore }, messages, { detectHostProfile }] = await Promise.all([
    import("@/stores/chat"),
    import("@/lib/db/messages"),
    import("@/lib/platform/capabilities"),
  ])
  return {
    store: useChatStore as unknown as VerificationFollowupStore,
    persist: (sessionId, list) => messages.persistMessages(sessionId, list),
    run: (input) => runVerifiedFreshAgentTurn(input),
    hostProfile: detectHostProfile,
    now: () => Date.now(),
    messageId: () => crypto.randomUUID(),
  }
}

function isSettled(status: ChatStatus): boolean {
  return status !== "streaming" && status !== "awaiting_approval"
}

/** Text of the last assistant message, provided it arrived after `knownIds`. */
export function newAssistantReply(
  messages: readonly UIMessage[],
  knownIds: ReadonlySet<string>
): string | null {
  let index = messages.length
  while (index > 0) {
    index -= 1
    const message = messages[index]
    if (message.role !== "assistant") continue
    if (knownIds.has(message.id)) return null
    const text = flattenMessageText(message as unknown as StoredMessage)
    return text || null
  }
  return null
}

function replacePart(
  messages: UIMessage[],
  messageId: string,
  next: VerificationVerdictPart
): UIMessage[] {
  return messages.map((message) =>
    message.id === messageId
      ? { ...message, parts: [next] as unknown as UIMessage["parts"] }
      : message
  )
}

/**
 * Watch `sessionId` until the main turn settles, then run the verifier and
 * leave its verdict in the conversation.
 *
 * Refuses (with a reason) instead of arming on a companion shell. Arm AFTER
 * the session has been flipped to `streaming`: the watcher fires on the first
 * state where the session is no longer streaming, and reads the turn's
 * outcome from the slice, so a refused or cancelled turn (an error diagnostic,
 * or no new assistant message) runs no verifier.
 */
export async function armVerifiedFreshAgentFollowup(
  input: ArmVerificationInput,
  deps?: VerificationFollowupDeps
): Promise<ArmVerificationResult> {
  const d = deps ?? (await productionFollowupDeps())
  if (!verificationAvailableOn(d.hostProfile())) {
    return { armed: false, reason: "companionShell" }
  }
  const initial = d.store.getState().sessions[input.sessionId]
  if (!initial) return { armed: false, reason: "noSession" }
  const knownIds = new Set(initial.messages.map((message) => message.id))

  let resolveSettled: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  let done = false
  let unsubscribe: () => void = () => {}

  const onSettled = async (slice: SessionSliceView) => {
    if (slice.errorDiagnostic) return
    const reply = newAssistantReply(slice.messages, knownIds)
    if (!reply) return

    const messageId = d.messageId()
    const running: VerificationVerdictPart = {
      type: "verification-verdict",
      status: "running",
      verificationSessionId: "",
      mainSessionId: input.sessionId,
      points: [],
      diffIncluded: false,
      startedAt: d.now(),
    }
    const state = d.store.getState()
    const current = state.sessions[input.sessionId]?.messages ?? slice.messages
    const withRunning: UIMessage[] = [
      ...current,
      { id: messageId, role: "assistant", parts: [running] as unknown as UIMessage["parts"] },
    ]
    state.replaceSessionMessages(input.sessionId, withRunning)
    await d.persist(input.sessionId, withRunning).catch(() => undefined)

    let final: VerificationVerdictPart
    try {
      const result = await d.run({
        mainSessionId: input.sessionId,
        mainSessionTitle: input.mainSessionTitle,
        request: input.request,
        reply,
        cwd: input.cwd,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      })
      final = {
        ...running,
        status: "completed",
        verificationSessionId: result.verificationSessionId,
        verdict: result.parsed.verdict,
        summary: result.parsed.summary,
        points: result.parsed.points,
        diffIncluded: result.diffIncluded,
        completedAt: d.now(),
      }
    } catch (error) {
      final = {
        ...running,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: d.now(),
      }
    }
    const latest = d.store.getState()
    const list = latest.sessions[input.sessionId]?.messages
    if (!list) return
    const withVerdict = replacePart(list, messageId, final)
    latest.replaceSessionMessages(input.sessionId, withVerdict)
    await d.persist(input.sessionId, withVerdict).catch(() => undefined)
  }

  const check = () => {
    if (done) return
    const slice = d.store.getState().sessions[input.sessionId]
    if (!slice) {
      done = true
      unsubscribe()
      resolveSettled()
      return
    }
    if (!isSettled(slice.status)) return
    done = true
    unsubscribe()
    void onSettled(slice)
      .catch((error) => console.warn("verified-fresh-agent follow-up failed", error))
      .finally(resolveSettled)
  }

  unsubscribe = d.store.subscribe(check)
  check()
  return { armed: true, settled }
}
