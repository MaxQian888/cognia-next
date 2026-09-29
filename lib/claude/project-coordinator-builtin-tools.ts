import type { UIMessage } from "ai"
import type { ChatSession, ProjectThreadDeclaredState } from "@cognia/agent-config-types"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { RememberFactResult } from "@/lib/memory/write/remember-fact"
import {
  parseSpawnTaskArgs,
  SPAWN_TASK_JSON_SCHEMA,
  type SpawnedTaskBrief,
} from "@/lib/tasks/spawn-task-core"
import type { ThreadRefusal } from "@/lib/project-coordinator/admission"
import type { CreateThreadInput } from "@/lib/project-coordinator/thread-session"
import type { StartThreadResult } from "@/lib/project-coordinator/thread-runtime"
import type { ParsedPreference } from "@/lib/project-coordinator/preferences"
import { PROJECT_PREFERENCE_KEYS } from "@/lib/project-coordinator/preferences"

/**
 * Builtin tools for project coordination (ADR-0204). Same family shape as the
 * session-peer / team tools: a name map, manifest entries with hand-written
 * JSON Schema, a predicate, and a runner that never throws. Every host effect
 * goes through {@link ProjectCoordinatorToolDeps}, wired in
 * `lib/project-coordinator/tool-deps.ts`.
 *
 * The coordinator family is gated on `projectRole === "coordinator"`, the
 * thread family on `projectRole === "thread"` (see `resolveSendOptions`); the
 * runner re-checks the caller's role, so a tool reaching the wrong session is
 * refused rather than trusted.
 */

export const PROJECT_COORDINATOR_BUILTIN_PLUGIN_ID = "cognia-project-coordinator-builtin"

export const PROJECT_COORDINATOR_TOOL_NAMES = {
  spawnThread: "spawn_thread",
  proposeThreads: "propose_threads",
  startThread: "start_thread",
  messageThread: "message_thread",
  listThreads: "list_threads",
  readThreadReport: "read_thread_report",
  stopThread: "stop_thread",
  resolveThread: "resolve_thread",
  rememberProjectNote: "remember_project_note",
  setProjectPreference: "set_project_preference",
} as const

export const PROJECT_THREAD_TOOL_NAMES = {
  reportToCoordinator: "report_to_coordinator",
} as const

const COORDINATOR_TOOLS = new Set<string>(Object.values(PROJECT_COORDINATOR_TOOL_NAMES))
const THREAD_TOOLS = new Set<string>(Object.values(PROJECT_THREAD_TOOL_NAMES))

export const MAX_PROPOSED_THREADS = 10
const MESSAGE_MAX_CHARS = 20_000
const NOTE_MAX_CHARS = 2_000
const FULL_REPORT_MESSAGES = 3

export interface ProjectCoordinatorManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

const briefProperties = (() => {
  const { mode: _mode, ...rest } = SPAWN_TASK_JSON_SCHEMA.properties as Record<string, unknown>
  return rest
})()
const briefRequired = SPAWN_TASK_JSON_SCHEMA.required as string[]

const threadIdSchema = {
  type: "object",
  additionalProperties: false,
  required: ["thread_id"],
  properties: { thread_id: { type: "string", minLength: 1 } },
}

function entry(
  name: string,
  description: string,
  jsonSchema: Record<string, unknown>
): ProjectCoordinatorManifestEntry {
  return { name, description, jsonSchema, pluginId: PROJECT_COORDINATOR_BUILTIN_PLUGIN_ID }
}

export function buildProjectCoordinatorManifestEntries(): ProjectCoordinatorManifestEntry[] {
  const T = PROJECT_COORDINATOR_TOOL_NAMES
  return [
    entry(
      T.spawnThread,
      "Start a worker thread for one self-contained piece of project work. The thread is a separate conversation (its own worktree and branch in a git workspace) that runs in the background and reports back here when its turn ends. Write the brief so it stands alone: the thread does not see this conversation. Set start=false to create it staged for the user to start.",
      {
        type: "object",
        additionalProperties: false,
        required: briefRequired,
        properties: {
          ...briefProperties,
          root_id: {
            type: "string",
            description: "Workspace root to work in; omit for the primary root.",
          },
          start: { type: "boolean", default: true },
        },
      }
    ),
    entry(
      T.proposeThreads,
      "Propose threads without starting them. The user sees a card with a Start button per thread. Use when the project prefers proposals, or when the split needs the user's judgement.",
      {
        type: "object",
        additionalProperties: false,
        required: ["threads"],
        properties: {
          threads: {
            type: "array",
            minItems: 1,
            maxItems: MAX_PROPOSED_THREADS,
            items: {
              type: "object",
              additionalProperties: false,
              required: briefRequired,
              properties: { ...briefProperties, root_id: { type: "string" } },
            },
          },
        },
      }
    ),
    entry(T.startThread, "Start a thread that was created staged.", threadIdSchema),
    entry(
      T.messageThread,
      "Send a follow-up to an existing thread (a correction, the next step, an answer to its question). The thread runs a new turn and reports back. Prefer this over a new thread for work in the same area.",
      {
        type: "object",
        additionalProperties: false,
        required: ["thread_id", "message"],
        properties: {
          thread_id: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1, maxLength: MESSAGE_MAX_CHARS },
        },
      }
    ),
    entry(
      T.listThreads,
      "List this project's threads with their live state, branch, pull request and last report.",
      {
        type: "object",
        additionalProperties: false,
        properties: { include_resolved: { type: "boolean", default: false } },
      }
    ),
    entry(
      T.readThreadReport,
      "Read a thread's latest result. With full=true, also its last few assistant messages.",
      {
        type: "object",
        additionalProperties: false,
        required: ["thread_id"],
        properties: {
          thread_id: { type: "string", minLength: 1 },
          full: { type: "boolean", default: false },
        },
      }
    ),
    entry(T.stopThread, "Stop a thread's running turn and mark it interrupted.", threadIdSchema),
    entry(
      T.resolveThread,
      "Mark a thread done. Use once its result is delivered (merged, answered, or no longer needed).",
      threadIdSchema
    ),
    entry(
      T.rememberProjectNote,
      "Remember a requirement, decision or pitfall for this project. Every future thread and coordinator turn can recall it.",
      {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", minLength: 1, maxLength: NOTE_MAX_CHARS } },
      }
    ),
    entry(
      T.setProjectPreference,
      "Change how this project runs when the user asks (e.g. 'run at most two threads', 'propose before starting').",
      {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: {
          key: { type: "string", enum: [...PROJECT_PREFERENCE_KEYS] },
          value: { type: ["integer", "boolean", "null"] },
        },
      }
    ),
  ]
}

export function buildProjectThreadManifestEntries(): ProjectCoordinatorManifestEntry[] {
  return [
    entry(
      PROJECT_THREAD_TOOL_NAMES.reportToCoordinator,
      "Record where this thread stands for the project coordinator: ready-for-review (a pull request is open), landing (approved, merging), or blocked (you need something only the user can give). Your final reply is reported to the coordinator automatically when the turn ends, together with this state — do not repeat the report here.",
      {
        type: "object",
        additionalProperties: false,
        required: ["state"],
        properties: {
          state: { type: "string", enum: ["ready-for-review", "landing", "blocked"] },
        },
      }
    ),
  ]
}

export function isProjectCoordinatorBuiltinTool(name: string): boolean {
  return COORDINATOR_TOOLS.has(name) || THREAD_TOOLS.has(name)
}

export interface ThreadSummary {
  id: string
  title: string
  status: ChatStatus
  lifecycle: NonNullable<ChatSession["attachedChild"]>["status"] | "unknown"
  declaredState?: ProjectThreadDeclaredState
  branch?: string
  pullRequest?: string
  resolved: boolean
  lastReport?: string
}

export interface ProjectCoordinatorToolDeps {
  getSession: (id: string) => Promise<ChatSession | undefined>
  listThreads: (coordinatorSessionId: string) => Promise<ChatSession[]>
  statusOf: (sessionId: string) => ChatStatus
  checkCreation: (
    projectId: string,
    coordinatorSessionId: string
  ) => Promise<{ kind: "allow" } | { kind: "refuse"; reason: ThreadRefusal }>
  createThread: (input: CreateThreadInput) => Promise<ChatSession>
  startThread: (threadId: string, by: "coordinator" | "user") => Promise<StartThreadResult>
  sendToThread: (threadId: string, text: string) => Promise<boolean>
  stopThread: (threadId: string) => Promise<void>
  resolveThread: (threadId: string) => Promise<boolean>
  listMessages: (sessionId: string) => Promise<UIMessage[]>
  remember: (input: { text: string; sessionId: string }) => Promise<RememberFactResult>
  setPreference: (projectId: string, key: unknown, value: unknown) => ParsedPreference
  declareThreadState: (thread: ChatSession, state: ProjectThreadDeclaredState) => Promise<void>
  gate: (payload: unknown) => boolean
  assistantText: (message: UIMessage | undefined) => string
}

type ToolError = { ok: false; error: string }
const fail = (error: string): ToolError => ({ ok: false, error })

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function summarize(thread: ChatSession, status: ChatStatus): ThreadSummary {
  const pr = thread.projectThread?.prRef
  return {
    id: thread.id,
    title: thread.title,
    status,
    lifecycle: thread.attachedChild?.status ?? "unknown",
    ...(thread.projectThread?.declaredState
      ? { declaredState: thread.projectThread.declaredState }
      : {}),
    ...(thread.executionContext?.branch ? { branch: thread.executionContext.branch } : {}),
    ...(pr ? { pullRequest: pr.url ?? `${pr.repo}#${pr.number ?? pr.branch}` } : {}),
    resolved: thread.projectThread?.resolvedAt !== undefined,
    ...(thread.attachedChild?.result?.summary
      ? { lastReport: thread.attachedChild.result.summary.slice(0, 600) }
      : {}),
  }
}

function describeStart(result: StartThreadResult): { status: string; reason?: string } {
  switch (result.kind) {
    case "started":
      return { status: "started" }
    case "pending-runtime":
      return { status: "starting", reason: "the chat runtime is starting; it will run shortly" }
    case "stage":
      return { status: "staged", reason: result.reason }
    case "refuse":
      return { status: "refused", reason: result.reason }
    case "not-startable":
      return { status: "not-startable", reason: result.reason }
  }
}

function refusalText(reason: ThreadRefusal): string {
  switch (reason) {
    case "disabled":
      return "Project coordination is turned off for this workspace"
    case "paused":
      return "The project is paused; ask the user to resume it"
    case "daily-cap":
      return "The project reached its daily thread limit; continue in existing threads or ask the user to raise the limit"
  }
}

async function requireCoordinator(
  sessionId: string,
  deps: ProjectCoordinatorToolDeps
): Promise<{ coordinator: ChatSession; projectId: string } | ToolError> {
  const coordinator = await deps.getSession(sessionId)
  if (coordinator?.projectRole !== "coordinator" || !coordinator.projectId) {
    return fail("This tool is only available to a project coordinator")
  }
  return { coordinator, projectId: coordinator.projectId }
}

async function requireOwnThread(
  coordinatorSessionId: string,
  threadId: unknown,
  deps: ProjectCoordinatorToolDeps
): Promise<ChatSession | ToolError> {
  const id = str(threadId)
  if (!id) return fail("thread_id must be a non-empty string")
  const thread = await deps.getSession(id)
  if (
    thread?.projectRole !== "thread" ||
    thread.projectThread?.coordinatorSessionId !== coordinatorSessionId
  ) {
    return fail(`No thread ${id} in this project`)
  }
  return thread
}

function isError(value: unknown): value is ToolError {
  return typeof value === "object" && value !== null && (value as ToolError).ok === false
}

function parseBrief(
  args: Record<string, unknown>
): { brief: SpawnedTaskBrief; rootId?: string } | ToolError {
  const parsed = parseSpawnTaskArgs({ ...args, mode: "aside" })
  if ("error" in parsed) return fail(parsed.error)
  const rootId = str(args.root_id)
  return { brief: parsed, ...(rootId ? { rootId } : {}) }
}

export async function runProjectCoordinatorBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: ProjectCoordinatorToolDeps | undefined,
  context: { sessionId: string }
): Promise<unknown> {
  if (!isProjectCoordinatorBuiltinTool(name)) return fail(`unknown project tool: ${name}`)
  if (!deps) return fail("Project coordination host dependencies are unavailable")
  try {
    if (THREAD_TOOLS.has(name)) return await runThreadTool(args, deps, context)
    return await runCoordinatorTool(name, args, deps, context)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

async function runThreadTool(
  args: Record<string, unknown>,
  deps: ProjectCoordinatorToolDeps,
  context: { sessionId: string }
): Promise<unknown> {
  const thread = await deps.getSession(context.sessionId)
  if (thread?.projectRole !== "thread" || !thread.projectThread) {
    return fail("This tool is only available to a project thread")
  }
  const state = args.state
  if (state !== "ready-for-review" && state !== "landing" && state !== "blocked") {
    return fail("state must be ready-for-review, landing or blocked")
  }
  await deps.declareThreadState(thread, state)
  return { ok: true, state }
}

async function runCoordinatorTool(
  name: string,
  args: Record<string, unknown>,
  deps: ProjectCoordinatorToolDeps,
  context: { sessionId: string }
): Promise<unknown> {
  const caller = await requireCoordinator(context.sessionId, deps)
  if (isError(caller)) return caller
  const { coordinator, projectId } = caller
  const T = PROJECT_COORDINATOR_TOOL_NAMES

  switch (name) {
    case T.spawnThread: {
      const parsed = parseBrief(args)
      if (isError(parsed)) return parsed
      const admission = await deps.checkCreation(projectId, coordinator.id)
      if (admission.kind === "refuse") return fail(refusalText(admission.reason))
      const thread = await deps.createThread({
        projectId,
        coordinatorSessionId: coordinator.id,
        brief: parsed.brief,
        ...(parsed.rootId ? { rootId: parsed.rootId } : {}),
        proposedBy: "coordinator",
      })
      const start =
        args.start === false
          ? { status: "staged", reason: "created staged on request" }
          : describeStart(await deps.startThread(thread.id, "coordinator"))
      return { ok: true, threadId: thread.id, title: thread.title, ...start }
    }
    case T.proposeThreads: {
      if (!Array.isArray(args.threads) || args.threads.length === 0) {
        return fail("threads must be a non-empty array")
      }
      if (args.threads.length > MAX_PROPOSED_THREADS) {
        return fail(`propose at most ${MAX_PROPOSED_THREADS} threads at once`)
      }
      const proposals: Array<SpawnedTaskBrief & { rootId?: string }> = []
      for (const [index, item] of args.threads.entries()) {
        if (typeof item !== "object" || item === null) return fail(`threads[${index}] is invalid`)
        const parsed = parseBrief(item as Record<string, unknown>)
        if (isError(parsed)) return fail(`threads[${index}]: ${parsed.error}`)
        proposals.push({ ...parsed.brief, ...(parsed.rootId ? { rootId: parsed.rootId } : {}) })
      }
      if (!deps.gate(proposals)) return fail("Proposal blocked by the PII redaction gate")
      return {
        ok: true,
        proposals,
        instruction:
          "The proposals are shown to the user with Start buttons. Do not start them yourself unless the user asks.",
      }
    }
    case T.startThread: {
      const thread = await requireOwnThread(coordinator.id, args.thread_id, deps)
      if (isError(thread)) return thread
      return {
        ok: true,
        threadId: thread.id,
        ...describeStart(await deps.startThread(thread.id, "coordinator")),
      }
    }
    case T.messageThread: {
      const thread = await requireOwnThread(coordinator.id, args.thread_id, deps)
      if (isError(thread)) return thread
      const message = str(args.message)
      if (!message) return fail("message must be a non-empty string")
      if (message.length > MESSAGE_MAX_CHARS) return fail("message is too long")
      if (!deps.gate({ message })) return fail("Message blocked by the PII redaction gate")
      const sent = await deps.sendToThread(thread.id, message)
      return sent
        ? { ok: true, threadId: thread.id, status: "sent" }
        : fail("The thread could not take a message now (project paused or runtime unavailable)")
    }
    case T.listThreads: {
      const includeResolved = args.include_resolved === true
      const threads = (await deps.listThreads(coordinator.id))
        .filter((thread) => includeResolved || thread.projectThread?.resolvedAt === undefined)
        .map((thread) => summarize(thread, deps.statusOf(thread.id)))
      return { ok: true, threads }
    }
    case T.readThreadReport: {
      const thread = await requireOwnThread(coordinator.id, args.thread_id, deps)
      if (isError(thread)) return thread
      const base = {
        ok: true,
        thread: summarize(thread, deps.statusOf(thread.id)),
        result: thread.attachedChild?.result?.summary ?? null,
      }
      if (args.full !== true) return base
      const recent = (await deps.listMessages(thread.id))
        .filter((message) => message.role === "assistant")
        .slice(-FULL_REPORT_MESSAGES)
        .map((message) => deps.assistantText(message))
        .filter(Boolean)
      return { ...base, recentAssistantMessages: recent }
    }
    case T.stopThread: {
      const thread = await requireOwnThread(coordinator.id, args.thread_id, deps)
      if (isError(thread)) return thread
      await deps.stopThread(thread.id)
      return { ok: true, threadId: thread.id, status: "interrupted" }
    }
    case T.resolveThread: {
      const thread = await requireOwnThread(coordinator.id, args.thread_id, deps)
      if (isError(thread)) return thread
      await deps.resolveThread(thread.id)
      return { ok: true, threadId: thread.id, status: "resolved" }
    }
    case T.rememberProjectNote: {
      const text = str(args.text)
      if (!text) return fail("text must be a non-empty string")
      if (text.length > NOTE_MAX_CHARS) return fail("text is too long")
      const result = await deps.remember({ text, sessionId: coordinator.id })
      return result.ok
        ? { ok: true, scope: result.scope }
        : fail(`Not remembered: ${result.reason}`)
    }
    case T.setProjectPreference: {
      const result = deps.setPreference(projectId, args.key, args.value)
      return result.ok ? { ok: true, key: args.key, value: args.value } : fail(result.error)
    }
    default:
      return fail(`unknown project tool: ${name}`)
  }
}
