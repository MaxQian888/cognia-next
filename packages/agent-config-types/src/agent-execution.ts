// Unified Agent execution contract (ADR-0090).
//
// Frozen vocabulary shared by the renderer resolver, the Rust hosts (which
// forward it opaquely through `SendOptions.extra`) and the Node sidecar's
// runtime adapters. Everything here must stay serialisable and secret-free:
// credentials travel as *references* only — raw keys ride `SendOptions.env` /
// `providerCredentials`, which are already inside the sidecar redaction set.
//
// Validation is hand-written guard style (this package has zero runtime
// dependencies and is source-exported into both jsdom and node consumers).

// ---- Policy vocabulary ------------------------------------------------------

/** Which runtime family the caller wants. `auto` defers to the resolver. */
export type AgentRuntimePolicy = "auto" | "claude-agent-sdk" | "ai-sdk"

/**
 * The runtime adapter actually frozen into a spec. Unlike
 * {@link AgentRuntimePolicy} this includes `external`, which is never chosen
 * by policy directly — it is derived from an external-agent binding (teammate
 * runtime / preset) by the resolver.
 */
export type AgentRuntimeAdapterId = "claude-agent-sdk" | "ai-sdk" | "external"

export type AgentRoutePolicy = "gateway-required" | "gateway-preferred" | "direct"

export type AgentExecutionTarget =
  { mode: "colocate" } | { mode: "auto" } | { mode: "pinned"; hostRef: string }

export type CredentialAffinity = "session-sticky" | "sticky-with-failover" | "per-request"

/**
 * Capability vocabulary for the compatibility matrix and the per-spec
 * effective set. "Hard" vs "preferred" is a property of the *request*
 * (`AgentExecutionPolicy.requires` / `prefers`), not of the id itself.
 */
export type AgentCapabilityId =
  | "streaming"
  | "session.multi-turn"
  | "session.resume"
  | "tools.ordinary"
  | "tools.parallel"
  | "tools.fragmented-json"
  | "tools.results"
  | "tools.errors"
  | "mcp"
  | "permissions.interrupt-resume"
  | "permissions.set-mode"
  | "prompt-caching"
  | "thinking"
  | "context-management"
  | "images"
  | "beta-features"
  | "rate-limit-handling"
  | "upstream-errors"
  | "stream-interruption"
  | "subagents.native"
  | "steer"
  | "set-model"
  | "checkpoint"
  | "compaction"
  // --- Claude Agent SDK 0.3.220 parity (see protocol/agent-sdk-surface.json) ---
  // Each of these names a surface the SDK exposes and the unified contract has
  // to be able to answer "yes / equivalent / no" about, per runtime. They are
  // deliberately runtime-neutral: an AI SDK adapter can satisfy
  // `output.structured` through its own JSON-schema path without the contract
  // caring how.
  | "output.structured"
  | "session.store"
  | "session.manage"
  | "permissions.update-rules"
  | "hooks.lifecycle"
  | "input.elicitation"
  | "input.dialog"
  | "plugins.native"
  | "skills.native"
  | "mcp.dynamic"
  | "subagents.manage"
  | "tasks.background"
  | "commands.dynamic"
  | "sandbox.native"
  | "observability.child"
  | "startup.prewarm"

export const AGENT_CAPABILITY_IDS: readonly AgentCapabilityId[] = [
  "streaming",
  "session.multi-turn",
  "session.resume",
  "tools.ordinary",
  "tools.parallel",
  "tools.fragmented-json",
  "tools.results",
  "tools.errors",
  "mcp",
  "permissions.interrupt-resume",
  "permissions.set-mode",
  "prompt-caching",
  "thinking",
  "context-management",
  "images",
  "beta-features",
  "rate-limit-handling",
  "upstream-errors",
  "stream-interruption",
  "subagents.native",
  "steer",
  "set-model",
  "checkpoint",
  "compaction",
  "output.structured",
  "session.store",
  "session.manage",
  "permissions.update-rules",
  "hooks.lifecycle",
  "input.elicitation",
  "input.dialog",
  "plugins.native",
  "skills.native",
  "mcp.dynamic",
  "subagents.manage",
  "tasks.background",
  "commands.dynamic",
  "sandbox.native",
  "observability.child",
  "startup.prewarm",
]

/**
 * How well a runtime satisfies a capability.
 *
 * The distinction that matters is `equivalent`: an adapter that reaches the
 * same observable outcome by another mechanism (an AI SDK provider doing
 * structured output through its own schema path rather than the SDK's
 * `outputFormat`). Recording it as `native` would erase a real behavioural
 * difference; recording it as `unsupported` would fail a session that works.
 */
export type AgentCapabilitySupport = "native" | "equivalent" | "unsupported"

/**
 * Per-capability verdict. `reason` is required for anything other than
 * `native` — an `unsupported` with no explanation is indistinguishable from an
 * unfinished adapter, and that ambiguity is what fail-closed exists to prevent.
 */
export interface AgentCapabilityEvidence {
  support: AgentCapabilitySupport
  reason?: string
}

/**
 * Caller-facing execution policy (plan §3.1). Everything is declarative;
 * the only authority that turns a policy into an executable decision is
 * `resolveAgentExecutionSpec()`.
 */
export interface AgentExecutionPolicy {
  executionKind: "agent" | "completion"
  runtimePolicy: AgentRuntimePolicy
  routePolicy: AgentRoutePolicy
  deploymentRef?: string
  modelBindingRef?: string
  credentialProfileRef?: string
  credentialAffinity?: CredentialAffinity
  executionTarget?: AgentExecutionTarget
  requires?: AgentCapabilityId[]
  prefers?: AgentCapabilityId[]
  fallbackPolicy?: "none" | "completion"
}

// ---- Identity ---------------------------------------------------------------

/**
 * Fixed identity hierarchy: session → run → turn → attempt → providerAttempt.
 * A host resume mints a new attempt; a Gateway pre-first-byte candidate switch
 * mints a new providerAttempt. Budget, trace, recovery and Team parent/child
 * aggregation all key off these ids.
 */
export interface AgentExecutionIdentity {
  sessionId: string
  runId: string
  turnId?: string
  attemptId: string
  providerAttemptId?: string
  parentRunId?: string
}

// ---- Resolved spec ----------------------------------------------------------

export type AgentCompatibilityEvidence =
  "native" | "vendor-certified" | "cognia-verified" | "experimental" | "unsupported"

export interface AgentModelBindings {
  primary: string
  fast?: string
  powerful?: string
}

export type AgentResolvedRoute =
  | {
      kind: "gateway"
      routePolicy: AgentRoutePolicy
      routePinId?: string
      /** Ticket *id*, never the ticket secret. */
      ticketRef?: string
    }
  | {
      kind: "direct"
      routePolicy: AgentRoutePolicy
      credentialProfileRef?: string
    }

/**
 * Current spec version. v2 adds `capabilities.support` — the per-capability
 * `native | equivalent | unsupported` verdict the SDK-parity work needs in
 * order to refuse a provider *before* spending a model turn rather than
 * discovering the gap mid-stream.
 *
 * v1 specs are still accepted on the way in and upcast by
 * {@link upgradeResolvedAgentExecutionSpec}; nothing new is ever emitted as v1.
 */
export const RESOLVED_SPEC_VERSION = 2

/**
 * Immutable output of `resolveAgentExecutionSpec()`. Serialisable, secret-free
 * and stable for the whole session: callers must never re-derive runtime,
 * route or host from anything else once a spec exists.
 */
export interface ResolvedAgentExecutionSpec {
  specVersion: 1 | 2
  identity: AgentExecutionIdentity
  /** Deterministic hash over the non-volatile spec fields (see fingerprint.ts). */
  executionFingerprint: string
  executionKind: "agent" | "completion"
  runtimeAdapter: AgentRuntimeAdapterId
  runtimePolicySource: "explicit" | "auto" | "legacy-mapped"
  deploymentRef?: string
  modelBindings: AgentModelBindings
  route: AgentResolvedRoute
  /** e.g. "desktop-sidecar" | "headless-agent-host" | a pinned ADR-0082 host ref. */
  hostRef: string
  compatibility: {
    evidence: AgentCompatibilityEvidence
    recordRef?: string
    suiteVersion?: string
  }
  capabilities: {
    effective: AgentCapabilityId[]
    /** Preferred-but-unavailable capabilities the resolver switched off. */
    disabledOptional: AgentCapabilityId[]
    /**
     * v2+. Per-capability verdict for everything in `effective`, plus any
     * capability the caller asked about and did not get. Absent on an
     * un-upcast v1 spec.
     */
    support?: Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>>
  }
  credential?: {
    /** Reference into the Provider Profile Store — never a value. */
    profileRef: string
    profileVersion?: string
    affinity: CredentialAffinity
  }
  fallbackPolicy: "none" | "completion"
  /** Set when legacy `toolsEnabled`/provider-id signals drove the mapping. */
  legacyMigrated?: boolean
}

// ---- SendOptions projection -------------------------------------------------

/**
 * The serialized projection of a {@link ResolvedAgentExecutionSpec} that rides
 * `SendOptions.execution` renderer → Rust (via the `extra` flatten) → sidecar.
 * The sidecar treats it as frozen: dispatch reads `runtimeAdapter` and never
 * re-derives the runtime from `provider`. Secrets (ticket secret, direct
 * credentials) are NOT here — they ride `SendOptions.env`.
 */
export interface AgentExecutionSendSpec {
  specVersion: 1 | 2
  executionFingerprint: string
  runtimeAdapter: AgentRuntimeAdapterId
  executionKind: "agent" | "completion"
  route:
    | { kind: "gateway"; endpoint: string; ticketId: string }
    | { kind: "direct"; credentialProfileRef?: string }
  modelBindings: AgentModelBindings
  capabilities: {
    effective: AgentCapabilityId[]
    disabledOptional: AgentCapabilityId[]
    /** v2+. Mirrors the resolved spec so the sidecar can fail closed too. */
    support?: Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>>
  }
  identity: { runId: string; parentRunId?: string; attemptId: string }
  hostRef: string
}

/**
 * Upcast a v1 spec to v2.
 *
 * A v1 spec carries no per-capability verdicts, and inventing them would be a
 * lie in the dangerous direction — claiming `native` for something never
 * tested. So every capability v1 listed as effective becomes `native` with an
 * explicit reason recording *why* we believe it: it was in `effective` under
 * the v1 static table, which only ever contained natively-supported ids. The
 * 16 SDK-parity capabilities added in v2 are simply absent, which the gate
 * treats as unsupported.
 *
 * Idempotent: a v2 spec is returned unchanged.
 */
export function upgradeResolvedAgentExecutionSpec(
  spec: ResolvedAgentExecutionSpec
): ResolvedAgentExecutionSpec {
  if (spec.specVersion === 2) return spec

  const support: Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>> = {}
  for (const id of spec.capabilities.effective) {
    support[id] = {
      support: "native",
      reason: "carried forward from a v1 spec, whose effective set was natively supported only",
    }
  }

  return {
    ...spec,
    specVersion: 2,
    capabilities: { ...spec.capabilities, support },
  }
}

// ---- Canonical events -------------------------------------------------------

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
export type CanonicalAgentEvent =
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

// ---- Decision trace ---------------------------------------------------------

export type AgentExecutionSurface =
  "chat" | "connector" | "agent-executor" | "workflow-agent-turn" | "team" | "plugin" | "cli"

/**
 * Secret-free record of one resolver decision. Only ids / enums / refs are
 * allowed — no env values, headers, URLs-with-credentials or key material.
 * Volatile by design: excluded from the execution fingerprint.
 */
export interface AgentExecutionDecisionTrace {
  traceId: string
  surface: AgentExecutionSurface
  at: string
  flags: Record<string, boolean>
  legacy: {
    providerId?: string
    modelId?: string
    proxyMode?: string
    runtime?: string
    toolsEnabled?: boolean
    requireTools?: boolean
    channel?: "sidecar" | "text" | "external"
  }
  resolved: {
    executionFingerprint: string
    runtimeAdapter: AgentRuntimeAdapterId
    executionKind: "agent" | "completion"
    routeKind: "gateway" | "direct"
    routePolicy: AgentRoutePolicy
    hostRef: string
    deploymentRef?: string
    modelBindingRef?: string
    fallbackPolicy: "none" | "completion"
    legacyMigrated?: boolean
    disabledOptional: AgentCapabilityId[]
  }
  divergence: Array<"runtime" | "route" | "model" | "fallback" | "host" | "kind">
}

// ---- Validators -------------------------------------------------------------

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const RUNTIME_POLICIES: readonly string[] = ["auto", "claude-agent-sdk", "ai-sdk"]
const RUNTIME_ADAPTERS: readonly string[] = ["claude-agent-sdk", "ai-sdk", "external"]
const ROUTE_POLICIES: readonly string[] = ["gateway-required", "gateway-preferred", "direct"]
const AFFINITIES: readonly string[] = ["session-sticky", "sticky-with-failover", "per-request"]
const EXECUTION_KINDS: readonly string[] = ["agent", "completion"]
const FALLBACK_POLICIES: readonly string[] = ["none", "completion"]

function isCapabilityIdArray(v: unknown): v is AgentCapabilityId[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === "string" && (AGENT_CAPABILITY_IDS as readonly string[]).includes(x))
  )
}

export function validateAgentExecutionPolicy(v: unknown): ValidationResult<AgentExecutionPolicy> {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["policy must be an object"] }

  if (!EXECUTION_KINDS.includes(v.executionKind as string)) {
    errors.push(`executionKind must be one of ${EXECUTION_KINDS.join("|")}`)
  }
  if (!RUNTIME_POLICIES.includes(v.runtimePolicy as string)) {
    errors.push(`runtimePolicy must be one of ${RUNTIME_POLICIES.join("|")}`)
  }
  if (!ROUTE_POLICIES.includes(v.routePolicy as string)) {
    errors.push(`routePolicy must be one of ${ROUTE_POLICIES.join("|")}`)
  }
  for (const key of ["deploymentRef", "modelBindingRef", "credentialProfileRef"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      errors.push(`${key} must be a string when present`)
    }
  }
  if (v.credentialAffinity !== undefined && !AFFINITIES.includes(v.credentialAffinity as string)) {
    errors.push(`credentialAffinity must be one of ${AFFINITIES.join("|")}`)
  }
  if (v.executionTarget !== undefined) {
    const t = v.executionTarget
    const okTarget =
      isRecord(t) &&
      (t.mode === "colocate" ||
        t.mode === "auto" ||
        (t.mode === "pinned" && typeof t.hostRef === "string" && t.hostRef.length > 0))
    if (!okTarget) errors.push("executionTarget must be colocate|auto|pinned{hostRef}")
  }
  for (const key of ["requires", "prefers"] as const) {
    if (v[key] !== undefined && !isCapabilityIdArray(v[key])) {
      errors.push(`${key} must be an array of known capability ids`)
    }
  }
  if (v.fallbackPolicy !== undefined && !FALLBACK_POLICIES.includes(v.fallbackPolicy as string)) {
    errors.push(`fallbackPolicy must be one of ${FALLBACK_POLICIES.join("|")}`)
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as AgentExecutionPolicy }
}

function validateIdentity(v: unknown, errors: string[], path: string): void {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object`)
    return
  }
  for (const key of ["sessionId", "runId", "attemptId"] as const) {
    if (typeof v[key] !== "string" || v[key].length === 0) {
      errors.push(`${path}.${key} must be a non-empty string`)
    }
  }
  for (const key of ["turnId", "providerAttemptId", "parentRunId"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      errors.push(`${path}.${key} must be a string when present`)
    }
  }
}

function validateModelBindings(v: unknown, errors: string[], path: string): void {
  if (!isRecord(v) || typeof v.primary !== "string" || v.primary.length === 0) {
    errors.push(`${path}.primary must be a non-empty string`)
    return
  }
  for (const key of ["fast", "powerful"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      errors.push(`${path}.${key} must be a string when present`)
    }
  }
}

const CAPABILITY_SUPPORTS: readonly string[] = ["native", "equivalent", "unsupported"]

/**
 * `capabilities.support` is v2-only, keyed by known capability ids, and every
 * non-`native` verdict must say why.
 *
 * The reason requirement is not decoration: an `unsupported` with no
 * explanation reads identically whether the runtime genuinely cannot do the
 * thing or an adapter was left half-written, and the whole point of
 * fail-closed is that those two must never be confused.
 */
function validateCapabilitySupport(support: unknown, specVersion: unknown, errors: string[]): void {
  if (support === undefined) {
    if (specVersion === 2) errors.push("capabilities.support is required on a v2 spec")
    return
  }
  if (specVersion === 1) {
    errors.push("capabilities.support is not valid on a v1 spec")
    return
  }
  if (!isRecord(support)) {
    errors.push("capabilities.support must be an object")
    return
  }

  for (const [id, entry] of Object.entries(support)) {
    if (!isAgentCapabilityId(id)) {
      errors.push(`capabilities.support has unknown capability id "${id}"`)
      continue
    }
    if (!isRecord(entry) || !CAPABILITY_SUPPORTS.includes(entry.support as string)) {
      errors.push(
        `capabilities.support.${id}.support must be one of ${CAPABILITY_SUPPORTS.join("|")}`
      )
      continue
    }
    if (entry.support !== "native" && (typeof entry.reason !== "string" || !entry.reason.trim())) {
      errors.push(`capabilities.support.${id} is "${entry.support}" and must carry a reason`)
    }
  }
}

export function validateResolvedAgentExecutionSpec(
  v: unknown
): ValidationResult<ResolvedAgentExecutionSpec> {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["spec must be an object"] }

  if (v.specVersion !== 1 && v.specVersion !== 2) errors.push("specVersion must be 1 or 2")
  validateIdentity(v.identity, errors, "identity")
  if (typeof v.executionFingerprint !== "string" || v.executionFingerprint.length === 0) {
    errors.push("executionFingerprint must be a non-empty string")
  }
  if (!EXECUTION_KINDS.includes(v.executionKind as string)) {
    errors.push(`executionKind must be one of ${EXECUTION_KINDS.join("|")}`)
  }
  if (!RUNTIME_ADAPTERS.includes(v.runtimeAdapter as string)) {
    errors.push(`runtimeAdapter must be one of ${RUNTIME_ADAPTERS.join("|")}`)
  }
  if (!["explicit", "auto", "legacy-mapped"].includes(v.runtimePolicySource as string)) {
    errors.push("runtimePolicySource must be explicit|auto|legacy-mapped")
  }
  validateModelBindings(v.modelBindings, errors, "modelBindings")

  const route = v.route
  if (!isRecord(route)) {
    errors.push("route must be an object")
  } else if (route.kind === "gateway") {
    if (!ROUTE_POLICIES.includes(route.routePolicy as string)) {
      errors.push("route.routePolicy must be a route policy")
    }
    for (const key of ["routePinId", "ticketRef"] as const) {
      if (route[key] !== undefined && typeof route[key] !== "string") {
        errors.push(`route.${key} must be a string when present`)
      }
    }
  } else if (route.kind === "direct") {
    if (!ROUTE_POLICIES.includes(route.routePolicy as string)) {
      errors.push("route.routePolicy must be a route policy")
    }
    if (
      route.credentialProfileRef !== undefined &&
      typeof route.credentialProfileRef !== "string"
    ) {
      errors.push("route.credentialProfileRef must be a string when present")
    }
  } else {
    errors.push("route.kind must be gateway|direct")
  }

  if (typeof v.hostRef !== "string" || v.hostRef.length === 0) {
    errors.push("hostRef must be a non-empty string")
  }

  const compat = v.compatibility
  if (
    !isRecord(compat) ||
    !["native", "vendor-certified", "cognia-verified", "experimental", "unsupported"].includes(
      compat.evidence as string
    )
  ) {
    errors.push("compatibility.evidence must be a known evidence level")
  }

  const caps = v.capabilities
  if (
    !isRecord(caps) ||
    !isCapabilityIdArray(caps.effective) ||
    !isCapabilityIdArray(caps.disabledOptional)
  ) {
    errors.push("capabilities.effective/disabledOptional must be capability id arrays")
  } else {
    validateCapabilitySupport(caps.support, v.specVersion, errors)
  }

  if (v.credential !== undefined) {
    const cred = v.credential
    if (
      !isRecord(cred) ||
      typeof cred.profileRef !== "string" ||
      cred.profileRef.length === 0 ||
      !AFFINITIES.includes(cred.affinity as string)
    ) {
      errors.push("credential must carry profileRef + affinity (reference only)")
    } else if ("value" in cred || "apiKey" in cred || "secret" in cred || "token" in cred) {
      errors.push("credential must not carry secret material")
    }
  }

  if (!FALLBACK_POLICIES.includes(v.fallbackPolicy as string)) {
    errors.push(`fallbackPolicy must be one of ${FALLBACK_POLICIES.join("|")}`)
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as ResolvedAgentExecutionSpec }
}

export function validateAgentExecutionSendSpec(
  v: unknown
): ValidationResult<AgentExecutionSendSpec> {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["execution spec must be an object"] }

  if (v.specVersion !== 1 && v.specVersion !== 2) errors.push("specVersion must be 1 or 2")
  if (typeof v.executionFingerprint !== "string" || v.executionFingerprint.length === 0) {
    errors.push("executionFingerprint must be a non-empty string")
  }
  if (!RUNTIME_ADAPTERS.includes(v.runtimeAdapter as string)) {
    errors.push(`runtimeAdapter must be one of ${RUNTIME_ADAPTERS.join("|")}`)
  }
  if (!EXECUTION_KINDS.includes(v.executionKind as string)) {
    errors.push(`executionKind must be one of ${EXECUTION_KINDS.join("|")}`)
  }

  const route = v.route
  if (!isRecord(route)) {
    errors.push("route must be an object")
  } else if (route.kind === "gateway") {
    if (typeof route.endpoint !== "string" || route.endpoint.length === 0) {
      errors.push("route.endpoint must be a non-empty string")
    }
    if (typeof route.ticketId !== "string" || route.ticketId.length === 0) {
      errors.push("route.ticketId must be a non-empty string")
    }
  } else if (route.kind === "direct") {
    if (
      route.credentialProfileRef !== undefined &&
      typeof route.credentialProfileRef !== "string"
    ) {
      errors.push("route.credentialProfileRef must be a string when present")
    }
  } else {
    errors.push("route.kind must be gateway|direct")
  }

  validateModelBindings(v.modelBindings, errors, "modelBindings")

  const caps = v.capabilities
  if (
    !isRecord(caps) ||
    !isCapabilityIdArray(caps.effective) ||
    !isCapabilityIdArray(caps.disabledOptional)
  ) {
    errors.push("capabilities.effective/disabledOptional must be capability id arrays")
  }

  const identity = v.identity
  if (
    !isRecord(identity) ||
    typeof identity.runId !== "string" ||
    identity.runId.length === 0 ||
    typeof identity.attemptId !== "string" ||
    identity.attemptId.length === 0
  ) {
    errors.push("identity must carry runId + attemptId")
  } else if (identity.parentRunId !== undefined && typeof identity.parentRunId !== "string") {
    errors.push("identity.parentRunId must be a string when present")
  }

  if (typeof v.hostRef !== "string" || v.hostRef.length === 0) {
    errors.push("hostRef must be a non-empty string")
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as AgentExecutionSendSpec }
}

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

/** Narrow helper used by tests + adapters when only capability ids are known at runtime. */
export function isAgentCapabilityId(v: unknown): v is AgentCapabilityId {
  return typeof v === "string" && (AGENT_CAPABILITY_IDS as readonly string[]).includes(v)
}
