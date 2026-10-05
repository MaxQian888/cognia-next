import {
  CANONICAL_AGENT_EVENT_KINDS,
  MODEL_REQUEST_PURPOSES,
  isAgentEventEnvelope,
  isKnownCanonicalAgentEventKind,
  type AgentEventEnvelope,
  type CanonicalAgentEvent,
} from "./canonical-event"

describe("canonical event vocabulary", () => {
  it("lists every kind once", () => {
    expect(new Set(CANONICAL_AGENT_EVENT_KINDS).size).toBe(CANONICAL_AGENT_EVENT_KINDS.length)
  })

  it("lists every model request purpose once", () => {
    expect(new Set(MODEL_REQUEST_PURPOSES).size).toBe(MODEL_REQUEST_PURPOSES.length)
    expect(MODEL_REQUEST_PURPOSES).toContain("turn")
  })
})

describe("isAgentEventEnvelope", () => {
  const envelope: AgentEventEnvelope = {
    schemaVersion: 1,
    eventId: "s1:a1:0",
    sequence: 0,
    sessionId: "s1",
    runId: "r1",
    turnId: "t1",
    attemptId: "a1",
    hostRef: "desktop-sidecar",
    runtime: "claude-agent-sdk",
    timestamp: "2026-07-23T00:00:00.000Z",
    event: { kind: "text-delta", delta: "hello" },
  }

  it("narrows valid envelopes across event kinds", () => {
    expect(isAgentEventEnvelope(envelope)).toBe(true)
    expect(
      isAgentEventEnvelope({
        ...envelope,
        event: { kind: "capability-error", capability: "steer", command: "steer" },
      })
    ).toBe(true)
    expect(
      isAgentEventEnvelope({
        ...envelope,
        event: { kind: "failure", code: "upstream_error", message: "boom" },
      })
    ).toBe(true)
    expect(
      isAgentEventEnvelope({
        ...envelope,
        event: { kind: "commentary-delta", delta: "Checking", messageId: "c1", done: false },
      })
    ).toBe(true)
  })

  it("rejects envelopes with missing ids or a negative sequence", () => {
    expect(isAgentEventEnvelope(null)).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, sessionId: "" })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, sequence: -1 })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, sequence: 1.5 })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, providerAttemptId: 3 })).toBe(false)
  })

  it("accepts an unknown event kind — the envelope is still well formed", () => {
    // The envelope's own contract says the event vocabulary grows additively
    // and consumers must ignore kinds they do not recognise. Rejecting here
    // meant an older host beside a newer one hard-refused every new event
    // instead of forwarding or persisting the frames it could still handle.
    expect(isAgentEventEnvelope({ ...envelope, event: { kind: "kind-from-the-future" } })).toBe(
      true
    )
  })

  it("still requires an event object with a non-empty kind", () => {
    expect(isAgentEventEnvelope({ ...envelope, event: { kind: "" } })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, event: { kind: 7 } })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, event: "text-delta" })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, event: undefined })).toBe(false)
  })

  it("separates 'well formed' from 'interpretable'", () => {
    // The distinction the two predicates exist to draw: a renderer gates on
    // the second before switching on the payload, a forwarder on the first.
    expect(isKnownCanonicalAgentEventKind("text-delta")).toBe(true)
    expect(isKnownCanonicalAgentEventKind("kind-from-the-future")).toBe(false)
    expect(isKnownCanonicalAgentEventKind(undefined)).toBe(false)
    expect(isKnownCanonicalAgentEventKind(7)).toBe(false)
  })

  it("rejects an envelope without schemaVersion 1", () => {
    const { schemaVersion: _dropped, ...withoutVersion } = envelope
    expect(isAgentEventEnvelope(withoutVersion)).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, schemaVersion: 2 })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, schemaVersion: "1" })).toBe(false)
  })

  it("accepts the elicitation, retry, queue and resource kinds", () => {
    const events: CanonicalAgentEvent[] = [
      {
        kind: "permission-request",
        requestId: "p1",
        toolName: "Edit",
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
      },
      { kind: "elicitation-request", requestId: "e1", source: "ask_user", prompt: "which?" },
      { kind: "elicitation-resolved", requestId: "e1", outcome: "timeout" },
      { kind: "retry", phase: "scheduled", attempt: 1, maxRetries: 2, code: "provider_error" },
      { kind: "queue", phase: "accepted", queueId: "q1", delivery: "after-settle" },
      {
        kind: "resource",
        phase: "trusted",
        resourceKind: "skill",
        origin: "/repo/.cognia/skills/a.md",
        digest: "sha256:abc",
      },
    ]
    for (const event of events) {
      expect(isAgentEventEnvelope({ ...envelope, event })).toBe(true)
    }
  })

  it("accepts every structured content-part variant without embedding binary bodies", () => {
    const events: CanonicalAgentEvent[] = [
      {
        kind: "content-part",
        partId: "sources-1",
        operation: "upsert",
        part: {
          type: "sources",
          sources: [
            {
              id: "s1",
              title: "Ink",
              origin: "github.com/vadimdemedes/ink",
              url: "https://github.com/vadimdemedes/ink",
              score: 0.98,
              snippet: "React for CLIs",
            },
          ],
        },
      },
      {
        kind: "content-part",
        partId: "file-1",
        operation: "upsert",
        part: {
          type: "file",
          name: "report.txt",
          uri: "artifact://session-1/report.txt",
          mediaType: "text/plain",
          size: 42,
          preview: "safe text preview",
        },
      },
      {
        kind: "content-part",
        partId: "surface-1",
        operation: "upsert",
        part: {
          type: "a2ui",
          surfaceId: "surface-1",
          source: "mcp-bridge",
          payload: { rootId: "root", components: [] },
        },
      },
      {
        kind: "content-part",
        partId: "artifact-1",
        operation: "upsert",
        part: { type: "artifact-ref", artifactId: "artifact-1", title: "Chart" },
      },
      {
        kind: "content-part",
        partId: "canvas-1",
        operation: "upsert",
        part: { type: "canvas-ref", canvasId: "canvas-1", title: "Architecture" },
      },
      {
        kind: "content-part",
        partId: "custom-1",
        operation: "upsert",
        part: { type: "custom", customType: "plugin.weather", summary: "Weather card" },
      },
      { kind: "content-part", partId: "file-1", operation: "remove" },
    ]

    for (const event of events) {
      expect(isAgentEventEnvelope({ ...envelope, event })).toBe(true)
      expect(JSON.stringify(event)).not.toMatch(/base64|data:/i)
    }
  })

  it("lists every canonical event kind exactly once", () => {
    expect(new Set(CANONICAL_AGENT_EVENT_KINDS).size).toBe(CANONICAL_AGENT_EVENT_KINDS.length)
    for (const kind of CANONICAL_AGENT_EVENT_KINDS) {
      expect(isAgentEventEnvelope({ ...envelope, event: { kind } })).toBe(true)
      expect(isKnownCanonicalAgentEventKind(kind)).toBe(true)
    }
  })

  it("accepts every SDK-parity kind added for the 39-member mapping", () => {
    const events: CanonicalAgentEvent[] = [
      { kind: "session-init", model: "claude-opus-5", tools: ["Bash"] },
      { kind: "activity", phase: "compacting", compactResult: "success" },
      { kind: "session-state", state: "requires-action" },
      { kind: "hook", phase: "completed", hookId: "h", hookName: "n", hookEvent: "PreToolUse" },
      { kind: "tool-progress", toolCallId: "t1", toolName: "Bash", elapsedMs: 1200 },
      { kind: "tool-summary", summary: "read three files", toolCallIds: ["t1"] },
      { kind: "auth", authenticating: false },
      { kind: "task", phase: "settled", taskId: "k1", status: "completed" },
      { kind: "task-inventory", tasks: [{ taskId: "k1", taskType: "agent", description: "d" }] },
      { kind: "notification", key: "n1", text: "done", priority: "low" },
      { kind: "informational", content: "heads up", level: "notice" },
      { kind: "commands-changed", commands: [{ name: "/review" }] },
      { kind: "memory-recall", mode: "select", memories: [{ path: "/m", scope: "team" }] },
      { kind: "files-persisted", files: [{ filename: "a.ts", fileId: "f1" }] },
      { kind: "model-refusal", originalModel: "a", content: "refused" },
      { kind: "local-command-output", content: "out" },
      { kind: "control-progress", requestId: "r1", status: "api-retry", attempt: 2 },
      { kind: "prompt-suggestion", suggestion: "try /review" },
      { kind: "conversation-reset", newConversationId: "c2" },
      {
        kind: "rate-limit",
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1_800_000,
        utilization: 0.91,
        overageStatus: "rejected",
        overageResetsAt: 1_900_000,
        overageDisabledReason: "out_of_credits",
        isUsingOverage: false,
        overageInUse: false,
        surpassedThreshold: 0.9,
        errorCode: "credits_required",
        canUserPurchaseCredits: true,
        hasChargeableSavedPaymentMethod: false,
      },
      { kind: "worker-shutdown", reason: "idle" },
      { kind: "mirror-error", error: "disk full", projectKey: "p" },
      { kind: "plugin-install", status: "installed", name: "p" },
      { kind: "user-replay", messageId: "m1", preview: "hi" },
    ]
    for (const event of events) {
      expect(isAgentEventEnvelope({ ...envelope, event })).toBe(true)
    }
  })
})
