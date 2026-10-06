/**
 * The canonical event contract (ADR-0090, ownership moved by ADR-0217).
 *
 * Every runtime — the built-in engines and every external integration —
 * translates its native stream into these events, wrapped in an
 * {@link AgentEventEnvelope}. Integration packages emit them, so the
 * vocabulary lives here rather than in the app's configuration hub;
 * `@cognia/agent-config-types/agent-execution` re-exports it unchanged.
 */

import type { AgentCapabilityId } from "./capability-ids"
import type { AgentExtensionUiUpdate } from "./extension-ui"

export interface CanonicalSourceReference {
  id: string
  title?: string
  origin?: string
  url?: string
  score?: number
  snippet?: string
}

/**
 * Structured assistant content that every renderer can preserve without
 * copying binary bodies into the durable event log.
 */
export type CanonicalContentPart =
  | { type: "sources"; sources: CanonicalSourceReference[] }
  | {
      type: "file"
      name: string
      /** Local/session artifact URI, or a trusted remote URL. Never a data URI. */
      uri: string
      mediaType?: string
      size?: number
      digest?: string
      /** Bounded, already-sanitized local text preview. */
      preview?: string
    }
  | {
      type: "a2ui"
      surfaceId: string
      source: "codeblock" | "tool-result" | "acp-stream" | "mcp-bridge" | "external"
      /** Validated JSON-compatible surface payload. */
      payload: Record<string, unknown>
    }
  | { type: "artifact-ref"; artifactId: string; title?: string; artifactType?: string }
  | { type: "canvas-ref"; canvasId: string; title?: string }
  | { type: "custom"; customType: string; summary: string; data?: unknown }

/**
 * Canonical event kinds, a superset of the capture layer's
 * `CaptureStreamEvent` plus lifecycle / permission / subagent / checkpoint /
 * failure kinds. Raw runtime payloads are allowed only inside the controlled
 * `diagnostic` attachment.
 */
/**
 * Why a model was called. Replay matches per purpose as well as per actor, so
 * a title or compaction call can never be served a tape recorded for the turn
 * itself even when the two happen to normalize to the same request.
 */
export type ModelRequestPurpose =
  "turn" | "subagent" | "compaction" | "title" | "summary" | "judge" | "embedding" | "other"

export const MODEL_REQUEST_PURPOSES: readonly ModelRequestPurpose[] = [
  "turn",
  "subagent",
  "compaction",
  "title",
  "summary",
  "judge",
  "embedding",
  "other",
]

export type CanonicalAgentEvent =
  | { kind: "extension-ui"; id: string; update: AgentExtensionUiUpdate }
  | { kind: "lifecycle"; phase: "started" | "ended" | "interrupted"; detail?: string }
  | {
      /**
       * The caller's input that opened this turn.
       *
       * Streaming rails never needed this — the caller already had the prompt
       * it just sent. The PERSISTED log does: without it the event stream is a
       * record of half a conversation, and `getMessages()` could not
       * reconstruct the user side on resume. Attachments are recorded as
       * references (path/digest/media type) only; bodies stay out of the log.
       */
      kind: "user-input"
      text: string
      attachments?: Array<{ kind: string; ref: string; digest?: string; mediaType?: string }>
    }
  | { kind: "text-delta"; delta: string }
  | { kind: "thinking-delta"; delta: string }
  | { kind: "commentary-delta"; delta: string; messageId?: string; done?: boolean }
  | {
      kind: "content-part"
      partId: string
      operation: "upsert" | "remove"
      /** Required for upsert and omitted for remove. */
      part?: CanonicalContentPart
    }
  | {
      kind: "tool-call"
      toolName: string
      input: Record<string, unknown>
      toolCallId?: string
    }
  | {
      kind: "tool-result"
      toolName: string
      toolCallId?: string
      input?: Record<string, unknown>
      result: unknown
      isError?: boolean
    }
  | {
      kind: "permission-request"
      requestId: string
      toolName: string
      input?: Record<string, unknown>
      defaultToNo?: boolean
      suppressAlwaysAllowRule?: boolean
    }
  | {
      kind: "permission-resolved"
      requestId: string
      behavior: "allow" | "deny"
    }
  | { kind: "subagent"; phase: "started" | "ended"; runtimeBinding?: string }
  | { kind: "usage"; usage: Record<string, unknown>; partial?: boolean }
  | {
      kind: "compact"
      trigger: "manual" | "auto"
      preTokens?: number
      postTokens?: number
    }
  | { kind: "checkpoint"; checkpointId: string }
  | {
      /**
       * The runtime is asking the *caller* (not the permission gate) for
       * structured input — the `ask_user` tool and its RPC/SDK equivalents.
       * Distinct from `permission-request`, which decides whether a tool may
       * run; an elicitation decides what it runs *with*.
       */
      kind: "elicitation-request"
      requestId: string
      /** Tool / surface that raised it ("ask_user", an MCP server id, …). */
      source: string
      prompt: string
      /** JSON Schema describing the expected answer, when the source supplied one. */
      schema?: Record<string, unknown>
    }
  | {
      kind: "elicitation-resolved"
      requestId: string
      /**
       * `declined` is a user choice; `cancelled` and `timeout` are the runtime
       * closing the request out (EOF, disconnect, shutdown, deadline). All
       * three resolve the pending waiter — none of them leaves it dangling.
       */
      outcome: "answered" | "declined" | "cancelled" | "timeout"
      /** Redaction-safe echo of what was returned. Never raw secret material. */
      answerSummary?: string
    }
  | {
      /**
       * A transient provider/transport failure being retried BEFORE any side
       * effect. `attempt` counts retries (1-based), so `attempt === maxRetries`
       * on the last `scheduled`. `exhausted` is terminal and is always followed
       * by a `failure`.
       */
      kind: "retry"
      phase: "scheduled" | "started" | "succeeded" | "exhausted"
      attempt: number
      maxRetries: number
      /** The failure code that triggered the retry. */
      code: string
      /** Backoff actually applied (post-jitter, post-`Retry-After` clamp). */
      delayMs?: number
      /** Server-advertised `Retry-After`, when one was honored. */
      retryAfterMs?: number
      message?: string
    }
  | {
      /**
       * Lifecycle of an enqueued follow-up prompt. `delivery` is the
       * EFFECTIVE delivery, not the requested one: a runtime that does not
       * advertise `steer` reports `after-settle` even when the caller asked
       * for `next-safe-boundary`, and never claims mid-turn injection.
       */
      kind: "queue"
      phase: "accepted" | "delivered" | "dropped"
      queueId: string
      delivery: "next-safe-boundary" | "after-settle"
      /** True when native steering carried it (capability `steer` was effective). */
      nativeSteering?: boolean
      reason?: string
    }
  | {
      /**
       * Audit record for an executable / instructional resource. Paths only
       * DISCOVER; `trusted` is emitted once the digest matched a trust record
       * or an explicit `--trust-resource`, and `rejected` when it did not (or
       * when the content changed after trust evaluation).
       */
      kind: "resource"
      phase: "discovered" | "trusted" | "rejected"
      resourceKind: "instructions" | "skill" | "plugin" | "mcp-config" | "command" | "attachment"
      /** Resolved absolute origin (path or URL) — never the body. */
      origin: string
      /** `sha256:<hex>` over the resolved content. */
      digest?: string
      reason?: string
    }
  | {
      /**
       * Session preamble: the runtime announcing what it resolved before the
       * first turn. Everything here is a *binding* the caller may not have
       * chosen explicitly (model aliases, discovered tools, MCP servers), so
       * dropping it loses the only record of what actually ran.
       */
      kind: "session-init"
      model?: string
      cwd?: string
      tools?: string[]
      mcpServers?: Array<{ name: string; status: string }>
      permissionMode?: string
      slashCommands?: string[]
    }
  | {
      /**
       * What the runtime is doing *right now*. Transient and self-superseding:
       * consumers render the latest and never accumulate. `idle` clears it.
       */
      kind: "activity"
      phase: "idle" | "requesting" | "compacting"
      /** Terminal outcome of a compaction that just finished, when known. */
      compactResult?: "success" | "failed"
      detail?: string
    }
  | {
      /**
       * The session's own state machine, distinct from {@link CanonicalAgentEvent}
       * `activity`: `requires-action` means the runtime is blocked on a human,
       * which outlives any single request.
       */
      kind: "session-state"
      state: "idle" | "running" | "requires-action"
    }
  | {
      /**
       * One hook invocation. `progress` may repeat; `completed` is terminal and
       * always carries an `outcome`. `blocked` records that the hook *stopped*
       * the operation — the security-relevant bit, kept separate from a
       * non-zero exit, which merely means the hook itself errored.
       */
      kind: "hook"
      phase: "started" | "progress" | "completed"
      hookId: string
      hookName: string
      hookEvent: string
      outcome?: "success" | "error" | "cancelled"
      exitCode?: number
      /** Hook stdout, already truncated by the emitter. Never parsed. */
      output?: string
      blocked?: boolean
      blockReason?: string
      additionalContext?: string
      warnings?: string[]
      /** Structured execution audit fields for one matched handler. */
      provider?: string
      handlerType?: string
      policyClass?: "user" | "managed"
      latencyMs?: number
      redacted?: boolean
      error?: string
    }
  | {
      /**
       * Liveness for an in-flight tool call. Purely additive to `tool-call` —
       * it never implies completion, and a heartbeat carries no new work.
       */
      kind: "tool-progress"
      toolCallId: string
      toolName: string
      elapsedMs: number
      parentToolCallId?: string
      taskId?: string
      heartbeat?: boolean
      subagentType?: string
    }
  | {
      /** Model-authored prose summarising one or more completed tool calls. */
      kind: "tool-summary"
      summary: string
      toolCallIds: string[]
    }
  | {
      /**
       * Credential state of the runtime process. `output` is the provider's own
       * human-readable lines — display only, never parsed, and never a secret
       * (the emitter is responsible for that, per ADR-0090 constraint 4).
       */
      kind: "auth"
      authenticating: boolean
      output?: string[]
      error?: string
    }
  | {
      /**
       * A background / delegated task. `settled` is terminal and carries a
       * `status`; `progress` may repeat. Distinct from `subagent`, which tracks
       * a *nested run*: a task may complete without ever spawning one.
       */
      kind: "task"
      phase: "started" | "updated" | "progress" | "settled"
      taskId: string
      toolCallId?: string
      description?: string
      subagentType?: string
      /** Present on `settled`, and on `updated` when the patch changed it. */
      status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused" | "stopped"
      summary?: string
      usage?: { totalTokens?: number; toolUses?: number; durationMs?: number }
      error?: string
      backgrounded?: boolean
    }
  | {
      /** The full set of live background tasks. Replaces, never merges. */
      kind: "task-inventory"
      tasks: Array<{ taskId: string; taskType: string; description: string }>
    }
  | {
      /**
       * A user-directed alert the runtime wants surfaced out-of-band (toast /
       * badge), keyed so a repeat replaces rather than stacks.
       */
      kind: "notification"
      key: string
      text: string
      priority: "low" | "medium" | "high" | "immediate"
      timeoutMs?: number
    }
  | {
      /**
       * An inline transcript notice. `preventContinuation` is load-bearing:
       * the runtime is telling the caller not to auto-continue the turn.
       */
      kind: "informational"
      content: string
      level: "info" | "notice" | "suggestion" | "warning"
      toolCallId?: string
      preventContinuation?: boolean
    }
  | {
      /** The runtime's slash-command inventory changed. Replaces, never merges. */
      kind: "commands-changed"
      commands: Array<{ name: string; description?: string; source?: string }>
    }
  | {
      /**
       * Memory pulled into context. `scope` is the sharing boundary, so this is
       * also the audit record for cross-tenant memory reaching a prompt.
       */
      kind: "memory-recall"
      mode: "select" | "synthesize"
      memories: Array<{ path: string; scope: "personal" | "team" | "organization" }>
    }
  | {
      /**
       * Files the runtime committed to durable storage. `failed` is not an
       * error for the turn — the turn continues — but it IS a durability gap,
       * so it is reported rather than folded into `files`.
       */
      kind: "files-persisted"
      files: Array<{ filename: string; fileId: string }>
      failed?: Array<{ filename: string; error: string }>
      processedAt?: string
    }
  | {
      /**
       * The model refused and the runtime either fell back to another model or
       * had none. `retractedEventIds` names messages the consumer must EVICT —
       * this arrives after the retraction, so it is a resolution-time signal,
       * and eviction is idempotent.
       */
      kind: "model-refusal"
      originalModel: string
      fallbackModel?: string
      direction?: "retry" | "revert" | "sticky"
      category?: string
      explanation?: string
      content: string
      retractedEventIds?: string[]
      refusedUserMessageId?: string
    }
  | {
      /** Output of a slash command the runtime executed locally, not via a tool. */
      kind: "local-command-output"
      content: string
    }
  | {
      /**
       * Progress on an in-flight control request. Distinct from `retry`, which
       * is about the *model* call; this is the control plane retrying.
       */
      kind: "control-progress"
      requestId: string
      status: "started" | "api-retry"
      attempt?: number
      maxRetries?: number
      delayMs?: number
    }
  | {
      /** A follow-up prompt the runtime suggests. Never auto-sent. */
      kind: "prompt-suggestion"
      suggestion: string
    }
  | {
      /**
       * The runtime discarded conversation history and started a new one. All
       * prior context is gone; consumers must not keep appending to the old id.
       */
      kind: "conversation-reset"
      newConversationId: string
    }
  | {
      /**
       * Provider rate-limit state. Self-clearing: `allowed` means the previous
       * marker must be REMOVED, not merely not-repeated.
       */
      kind: "rate-limit"
      status: "allowed" | "allowed_warning" | "rejected"
      rateLimitType?: string
      /** Epoch seconds, as the provider reports it. */
      resetsAt?: number
      /** Native subscription utilization, independent of token/cost accounting. */
      utilization?: number
      overageStatus?: "allowed" | "allowed_warning" | "rejected"
      /** Epoch seconds, as the provider reports it. */
      overageResetsAt?: number
      overageDisabledReason?: string
      isUsingOverage?: boolean
      overageInUse?: boolean
      surpassedThreshold?: number
      errorCode?: string
      canUserPurchaseCredits?: boolean
      hasChargeableSavedPaymentMethod?: boolean
    }
  | {
      /**
       * The runtime worker is going away. Not a failure by itself — an orderly
       * shutdown still settles in-flight work — but no new turn will start.
       */
      kind: "worker-shutdown"
      reason: string
    }
  | {
      /**
       * The raw session mirror failed to persist an entry. Deliberately NOT a
       * `failure`: the turn is unaffected and still succeeds. It is a
       * durability alarm — the SDK-side record of this session is now
       * incomplete, so resume/checkpoint may not find what the transcript shows.
       */
      kind: "mirror-error"
      error: string
      projectKey?: string
      storeSessionId?: string
      subpath?: string
    }
  | {
      /**
       * Plugin installation lifecycle. Separate from `resource`, whose
       * `trusted` / `rejected` phases mean a digest was checked against a trust
       * record — installing something is not the same as trusting it, and
       * conflating them would corrupt the trust audit.
       */
      kind: "plugin-install"
      status: "started" | "installed" | "failed" | "completed"
      name?: string
      error?: string
    }
  | {
      /**
       * The runtime echoing a user message back with the id it assigned. This
       * is what makes checkpointing addressable — `rewindFiles` needs the uuid,
       * and without the replay the caller never learns it. Not a second copy of
       * the user's turn: consumers key on `messageId` and do not re-render.
       */
      kind: "user-replay"
      messageId: string
      /** Redaction-safe preview. The full body already rode `user-input`. */
      preview?: string
      synthetic?: boolean
    }
  | {
      /**
       * How a turn that requested `outputFormat: { type: "json_schema" }`
       * settled. Emitted at most once per turn, immediately before the turn's
       * `lifecycle`/`failure`, and never for a turn that asked for no schema.
       *
       * Its reason for existing is that three of the four outcomes are
       * invisible in the events around it: `retries-exhausted` and
       * `turn-incomplete` are already failures but say nothing about the
       * schema, and `missing` arrives as an ordinary SUCCESS — the turn
       * finished, the model just answered in prose. A consumer watching only
       * `lifecycle` cannot tell that case from a satisfied contract.
       *
       * `output` carries the parsed value, which is the one thing here not
       * already in the stream; the raw text is not copied in, since the answer
       * already rode the `text-delta` events.
       *
       * @see classifyStructuredOutcome in `claude-agent-sdk-options.ts`
       */
      kind: "structured-output"
      status: "ok" | "missing" | "retries-exhausted" | "turn-incomplete"
      output?: unknown
    }
  | {
      /**
       * Shadow record of one model request (ADR-0118).
       *
       * Digests and artifact references ONLY. The prompt, the normalized
       * messages, the tool schemas and the response never ride this event —
       * when recording is enabled they go to the encrypted eval asset store and
       * `surfaceRef` points at them, so an ordinary run's durable log stays
       * free of model content.
       */
      kind: "model-request"
      purpose: ModelRequestPurpose
      provider: string
      model: string
      /** Replay match key: normalized messages + resolved config + tools. */
      requestDigest: string
      promptDigest: string
      toolDigest: string
      compositionDigest?: string
      executionFingerprint?: string
      /** Encrypted-asset reference; absent unless recording was enabled. */
      surfaceRef?: string
    }
  | { kind: "warning"; code: string; message: string }
  | { kind: "failure"; code: string; message: string; retryable?: boolean }
  | { kind: "capability-error"; capability: AgentCapabilityId; command?: string }
  | { kind: "diagnostic"; runtime: string; payload: unknown }

/**
 * Envelope wrapped around every canonical event (plan §3.5). Delivery is
 * at-least-once; consumers dedupe on `eventId`. `sequence` is monotonic
 * within an attempt.
 */
export interface AgentEventEnvelope {
  /**
   * Wire-format version of the envelope itself. Bumped only for a breaking
   * change to the envelope fields — the `event` vocabulary grows additively,
   * and consumers must ignore unknown `event.kind` values rather than fail.
   */
  schemaVersion: 1
  eventId: string
  sequence: number
  sessionId: string
  runId: string
  turnId: string
  attemptId: string
  providerAttemptId?: string
  parentRunId?: string
  hostRef: string
  runtime: string
  timestamp: string
  event: CanonicalAgentEvent
}

// ---- Kinds and guards -------------------------------------------------------

const CANONICAL_EVENT_KINDS: readonly string[] = [
  "lifecycle",
  "user-input",
  "text-delta",
  "thinking-delta",
  "commentary-delta",
  "content-part",
  "tool-call",
  "tool-result",
  "permission-request",
  "permission-resolved",
  "subagent",
  "usage",
  "compact",
  "checkpoint",
  "elicitation-request",
  "elicitation-resolved",
  "retry",
  "queue",
  "resource",
  "session-init",
  "activity",
  "session-state",
  "hook",
  "tool-progress",
  "tool-summary",
  "auth",
  "task",
  "task-inventory",
  "notification",
  "extension-ui",
  "informational",
  "commands-changed",
  "memory-recall",
  "files-persisted",
  "model-refusal",
  "local-command-output",
  "control-progress",
  "prompt-suggestion",
  "conversation-reset",
  "rate-limit",
  "worker-shutdown",
  "mirror-error",
  "plugin-install",
  "user-replay",
  "structured-output",
  "model-request",
  "warning",
  "failure",
  "capability-error",
  "diagnostic",
]

/** Every canonical event kind, in declaration order. Exported for exhaustiveness tests. */
export const CANONICAL_AGENT_EVENT_KINDS: readonly CanonicalAgentEvent["kind"][] =
  CANONICAL_EVENT_KINDS as readonly CanonicalAgentEvent["kind"][]

/**
 * Whether `kind` is a canonical event kind THIS build knows about.
 *
 * Deliberately separate from {@link isAgentEventEnvelope}: the envelope check
 * answers "is this a well-formed frame?", which a newer host's event still is.
 * This answers "can I interpret it?", which is a different question and the one
 * a renderer actually needs before switching on the payload.
 */
export function isKnownCanonicalAgentEventKind(kind: unknown): kind is CanonicalAgentEvent["kind"] {
  return typeof kind === "string" && CANONICAL_EVENT_KINDS.includes(kind)
}

/**
 * Structural validation of an envelope frame.
 *
 * Unknown `event.kind` values PASS. The vocabulary grows additively and the
 * envelope's own contract (see {@link AgentEventEnvelope.schemaVersion}) says
 * consumers must ignore kinds they do not recognise rather than fail — an older
 * host running beside a newer one would otherwise hard-reject every new event
 * and silently lose the frames it *could* have persisted or forwarded. Callers
 * that need to interpret the payload gate on
 * {@link isKnownCanonicalAgentEventKind} instead.
 */
export function isAgentEventEnvelope(v: unknown): v is AgentEventEnvelope {
  if (!isRecord(v)) return false
  if (v.schemaVersion !== 1) return false
  if (typeof v.eventId !== "string" || v.eventId.length === 0) return false
  if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 0) {
    return false
  }
  for (const key of ["sessionId", "runId", "turnId", "attemptId", "hostRef", "runtime"] as const) {
    if (typeof v[key] !== "string" || v[key].length === 0) return false
  }
  for (const key of ["providerAttemptId", "parentRunId"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") return false
  }
  if (typeof v.timestamp !== "string" || v.timestamp.length === 0) return false
  const event = v.event
  if (!isRecord(event) || typeof event.kind !== "string" || event.kind.length === 0) return false
  return true
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
