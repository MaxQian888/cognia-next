/**
 * Run an AI commit-message request on the agent the composer has selected.
 *
 * Which lane writes the message is decided once, by {@link commitMessageTarget}:
 *
 *  - `external` — a locally configured agent process (Codex, Claude Code, …).
 *    Runs in a FRESH session, in `plan` permission mode, with the repository as
 *    its working directory, so it may read files for context and nothing else:
 *    every permission request that is not a read is refused here.
 *  - `host`     — a configuration the paired host owns, run on the host through
 *    the companion plane. The host picks its own working directory, so the
 *    prompt carries everything the agent needs.
 *  - `model`    — the built-in lane, or `source: "model"`. There is no separate
 *    agent process to run, so the caller uses the utility model client.
 *
 * The executors are injected (`CommitAgentDeps`): the manager and the remote
 * run client are heavy modules the hook loads on demand, and injecting them
 * keeps this module testable without either.
 *
 * Privacy is the caller's: the prompt handed in is already PII-gated.
 */

import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import type {
  AcpPermissionRequest,
  AcpPermissionResponse,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentResult,
} from "@/types/agent/external-agent"
import type { ExternalAgentConfigStamp } from "@/types/agent/external-agent-config-store"
import type { GitCommitAiSource } from "@/types/git"

export type CommitMessageTarget =
  | { kind: "external"; agentId: string }
  | { kind: "host"; stamp: ExternalAgentConfigStamp }
  | { kind: "model" }

/** Where a commit message is generated, from the setting and the selected lane. */
export function commitMessageTarget(
  source: GitCommitAiSource | undefined,
  ref: AgentRuntimeRef
): CommitMessageTarget {
  if (source === "model") return { kind: "model" }
  switch (ref.kind) {
    case "external":
      return { kind: "external", agentId: ref.agentId }
    case "host":
      return {
        kind: "host",
        stamp: {
          configId: ref.configId,
          revision: ref.revision,
          lifecycleGeneration: ref.lifecycleGeneration,
        },
      }
    default:
      return { kind: "model" }
  }
}

/** Generous: an agent may read a few files before it answers. */
export const COMMIT_AGENT_TIMEOUT_MS = 180_000

/**
 * Tool kinds a commit-message run may use without asking. Reading the
 * repository is the point of handing the task to an agent; writing to it, or
 * running anything, is not.
 */
const READ_ONLY_TOOL_KINDS = new Set(["read", "search", "think", "file_read"])

/** Allow a read once, refuse everything else. Never asks the user. */
export function decideCommitAgentPermission(request: AcpPermissionRequest): AcpPermissionResponse {
  const requestId = request.requestId ?? request.id
  const kind = request.kind
  if (kind && READ_ONLY_TOOL_KINDS.has(kind)) {
    const allow = request.options?.find((option) => option.kind === "allow_once")
    return {
      requestId,
      granted: true,
      scope: "once",
      ...(allow ? { optionId: allow.optionId } : {}),
    }
  }
  const reject = request.options?.find((option) => option.kind === "reject_once")
  return {
    requestId,
    granted: false,
    scope: "once",
    reason: "Commit message generation is read-only",
    ...(reject ? { optionId: reject.optionId } : {}),
  }
}

export interface CommitAgentDeps {
  executeExternal: (
    prompt: string,
    options: ExternalAgentExecutionOptions & { agentId: string }
  ) => Promise<ExternalAgentResult | null>
  cancelExternal: (agentId: string, sessionId: string) => Promise<void>
  executeHost: (
    prompt: string,
    options: {
      stamp: ExternalAgentConfigStamp
      chatSessionId: string
      systemPrompt?: string
      onEvent?: (event: ExternalAgentEvent) => void
      newRunId?: () => string
    }
  ) => Promise<ExternalAgentResult | null>
  interruptHost: (runId: string) => Promise<void>
  newId: () => string
}

export interface RunCommitAgentInput {
  prompt: string
  systemPrompt: string
  /** The repository on this machine. Omitted for a repository on a paired host. */
  workingDirectory?: string
  signal?: AbortSignal
  /** The text so far, as it streams. */
  onText?: (text: string) => void
}

/** The run was cancelled by the caller. */
export class CommitAgentAbortedError extends Error {
  constructor() {
    super("Commit message generation was cancelled")
    this.name = "CommitAgentAbortedError"
  }
}

/** The selected agent could not be reached, or its turn failed. */
export class CommitAgentFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CommitAgentFailedError"
  }
}

function textDelta(event: ExternalAgentEvent): string {
  if (event.type !== "message_delta") return ""
  return event.delta.type === "text" ? event.delta.text : ""
}

/**
 * Run the agent lane and return its raw final answer. The caller extracts the
 * message from it ({@link extractCommitMessage} in `./ai-commit`).
 */
export async function runCommitMessageAgent(
  target: Exclude<CommitMessageTarget, { kind: "model" }>,
  input: RunCommitAgentInput,
  deps: CommitAgentDeps
): Promise<string> {
  if (input.signal?.aborted) throw new CommitAgentAbortedError()

  let streamed = ""
  let sessionId: string | undefined
  const onEvent = (event: ExternalAgentEvent) => {
    if (event.sessionId) sessionId = event.sessionId
    const delta = textDelta(event)
    if (!delta) return
    streamed += delta
    input.onText?.(streamed)
  }

  let cancel: () => void
  let run: Promise<ExternalAgentResult | null>
  if (target.kind === "external") {
    run = deps.executeExternal(input.prompt, {
      agentId: target.agentId,
      systemPrompt: input.systemPrompt,
      permissionMode: "plan",
      // Never resume the conversation this agent last ran in: a commit message
      // is its own task, and a chat's history would steer it.
      resetExternalSession: true,
      timeout: COMMIT_AGENT_TIMEOUT_MS,
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
      onEvent,
      onPermissionRequest: async (request) => decideCommitAgentPermission(request),
    })
    cancel = () => {
      if (sessionId) void deps.cancelExternal(target.agentId, sessionId).catch(() => undefined)
    }
  } else {
    const runId = `rer_${deps.newId()}`
    run = deps.executeHost(input.prompt, {
      stamp: target.stamp,
      // Frames are addressed to a chat session; this run belongs to none, so
      // it gets an id of its own that no conversation will ever claim.
      chatSessionId: `source-control:commit:${deps.newId()}`,
      systemPrompt: input.systemPrompt,
      onEvent,
      newRunId: () => runId,
    })
    cancel = () => void deps.interruptHost(runId)
  }

  // Cancelling answers at once: the UI must not wait on an agent that is still
  // winding down. The run's own result, when it lands, is dropped.
  const aborted = new Promise<never>((_, reject) => {
    if (!input.signal) return
    input.signal.addEventListener(
      "abort",
      () => {
        cancel()
        reject(new CommitAgentAbortedError())
      },
      { once: true }
    )
  })

  const result = await Promise.race([run, aborted])
  if (!result) throw new CommitAgentFailedError("The selected agent is not available")
  if (!result.success) {
    throw new CommitAgentFailedError(result.error ?? "The selected agent did not finish")
  }
  return result.finalResponse || streamed
}
