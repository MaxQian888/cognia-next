import {
  AGENT_CAPABILITY_IDS,
  CANONICAL_AGENT_EVENT_KINDS,
  RESOLVED_SPEC_VERSION,
  isAgentCapabilityId,
  isAgentEventEnvelope,
  isKnownCanonicalAgentEventKind,
  upgradeResolvedAgentExecutionSpec,
  validateAgentExecutionPolicy,
  validateAgentExecutionSendSpec,
  validateResolvedAgentExecutionSpec,
} from "./agent-execution"
import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
  AgentExecutionPolicy,
  AgentExecutionSendSpec,
  ResolvedAgentExecutionSpec,
} from "./agent-execution"

import SDK_SURFACE from "../../../protocol/agent-sdk-surface.json"

const validPolicy: AgentExecutionPolicy = {
  executionKind: "agent",
  runtimePolicy: "auto",
  routePolicy: "gateway-preferred",
  requires: ["tools.ordinary", "streaming"],
  prefers: ["prompt-caching"],
  fallbackPolicy: "none",
}

const validSpec: ResolvedAgentExecutionSpec = {
  specVersion: 1,
  identity: { sessionId: "s1", runId: "r1", attemptId: "a1" },
  executionFingerprint: "fp-abc",
  executionKind: "agent",
  runtimeAdapter: "claude-agent-sdk",
  runtimePolicySource: "auto",
  modelBindings: { primary: "claude-sonnet-5", fast: "claude-haiku-4-5-20251001" },
  route: { kind: "direct", routePolicy: "direct", credentialProfileRef: "cp-1" },
  hostRef: "desktop-sidecar",
  compatibility: { evidence: "native" },
  capabilities: { effective: ["streaming", "tools.ordinary"], disabledOptional: [] },
  fallbackPolicy: "none",
}

const validSendSpec: AgentExecutionSendSpec = {
  specVersion: 1,
  executionFingerprint: "fp-abc",
  runtimeAdapter: "claude-agent-sdk",
  executionKind: "agent",
  route: { kind: "gateway", endpoint: "http://127.0.0.1:47823/v1", ticketId: "tk-1" },
  modelBindings: { primary: "claude-sonnet-5" },
  capabilities: { effective: ["streaming"], disabledOptional: [] },
  identity: { runId: "r1", attemptId: "a1" },
  hostRef: "desktop-sidecar",
}

describe("validateAgentExecutionPolicy", () => {
  it("accepts a full valid policy", () => {
    const result = validateAgentExecutionPolicy(validPolicy)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.runtimePolicy).toBe("auto")
  })

  it("accepts pinned execution targets and rejects malformed ones", () => {
    const pinned = validateAgentExecutionPolicy({
      ...validPolicy,
      executionTarget: { mode: "pinned", hostRef: "host-2" },
    })
    expect(pinned.ok).toBe(true)

    const badPin = validateAgentExecutionPolicy({
      ...validPolicy,
      executionTarget: { mode: "pinned" },
    })
    expect(badPin.ok).toBe(false)
  })

  it("rejects non-objects, bad enums and unknown capability ids", () => {
    expect(validateAgentExecutionPolicy(null).ok).toBe(false)
    expect(validateAgentExecutionPolicy("policy").ok).toBe(false)

    const badEnum = validateAgentExecutionPolicy({ ...validPolicy, routePolicy: "maybe" })
    expect(badEnum.ok).toBe(false)
    if (!badEnum.ok) {
      expect(badEnum.errors.join(" ")).toContain("routePolicy")
    }

    const badCaps = validateAgentExecutionPolicy({ ...validPolicy, requires: ["not-a-cap"] })
    expect(badCaps.ok).toBe(false)

    const badAffinity = validateAgentExecutionPolicy({
      ...validPolicy,
      credentialAffinity: "forever",
    })
    expect(badAffinity.ok).toBe(false)
  })
})

describe("validateResolvedAgentExecutionSpec", () => {
  it("accepts a valid direct spec and a valid gateway spec", () => {
    expect(validateResolvedAgentExecutionSpec(validSpec).ok).toBe(true)

    const gateway = validateResolvedAgentExecutionSpec({
      ...validSpec,
      route: {
        kind: "gateway",
        routePolicy: "gateway-required",
        routePinId: "pin-1",
        ticketRef: "tk-1",
      },
      credential: { profileRef: "cp-1", affinity: "sticky-with-failover" },
    })
    expect(gateway.ok).toBe(true)
  })

  it("rejects missing identity fields, bad version and bad route kinds", () => {
    const noIdentity = validateResolvedAgentExecutionSpec({
      ...validSpec,
      identity: { sessionId: "s1", runId: "", attemptId: "a1" },
    })
    expect(noIdentity.ok).toBe(false)

    // 1 and 2 are both live; 3 is not. (Before contract v2 this case used 2,
    // which would now pass the version check and fail only on the missing
    // `capabilities.support` — right answer, wrong reason.)
    const badVersion = validateResolvedAgentExecutionSpec({ ...validSpec, specVersion: 3 })
    expect(badVersion.ok).toBe(false)
    if (!badVersion.ok) expect(badVersion.errors.join()).toMatch(/specVersion must be 1 or 2/)

    const badRoute = validateResolvedAgentExecutionSpec({
      ...validSpec,
      route: { kind: "carrier-pigeon" },
    })
    expect(badRoute.ok).toBe(false)
  })

  it("rejects credential blobs that carry secret material", () => {
    const withSecret = validateResolvedAgentExecutionSpec({
      ...validSpec,
      credential: { profileRef: "cp-1", affinity: "per-request", apiKey: "sk-live" },
    })
    expect(withSecret.ok).toBe(false)
    if (!withSecret.ok) {
      expect(withSecret.errors.join(" ")).toContain("secret material")
    }
  })

  it("requires primary model binding", () => {
    const noPrimary = validateResolvedAgentExecutionSpec({
      ...validSpec,
      modelBindings: { fast: "claude-haiku-4-5-20251001" },
    })
    expect(noPrimary.ok).toBe(false)
  })
})

describe("validateAgentExecutionSendSpec", () => {
  it("accepts gateway and direct variants", () => {
    expect(validateAgentExecutionSendSpec(validSendSpec).ok).toBe(true)
    expect(
      validateAgentExecutionSendSpec({
        ...validSendSpec,
        route: { kind: "direct", credentialProfileRef: "cp-1" },
      }).ok
    ).toBe(true)
  })

  it("rejects gateway routes without endpoint/ticket and identities without runId", () => {
    const noTicket = validateAgentExecutionSendSpec({
      ...validSendSpec,
      route: { kind: "gateway", endpoint: "http://127.0.0.1:1" },
    })
    expect(noTicket.ok).toBe(false)

    const noRun = validateAgentExecutionSendSpec({
      ...validSendSpec,
      identity: { attemptId: "a1" },
    })
    expect(noRun.ok).toBe(false)
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

  it("carries a kind for every SDK message the surface manifest declares", () => {
    // The 39-member union projects onto this vocabulary. `check:sdk-surface`
    // verifies the manifest against the installed `sdk.d.ts`; this verifies the
    // other end of the same claim — that every kind the manifest promises
    // actually exists in the contract.
    const declared = new Set(
      Object.values(
        SDK_SURFACE.surface.messages as Record<string, { canonical?: string[] }>
      ).flatMap((entry) => entry.canonical ?? [])
    )
    expect(declared.size).toBeGreaterThan(0)
    for (const kind of declared) {
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
      { kind: "rate-limit", status: "rejected", resetsAt: 1_800_000 },
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

describe("capability id registry", () => {
  it("has unique ids and a working narrow guard", () => {
    expect(new Set(AGENT_CAPABILITY_IDS).size).toBe(AGENT_CAPABILITY_IDS.length)
    expect(isAgentCapabilityId("tools.parallel")).toBe(true)
    expect(isAgentCapabilityId("tools.telepathy")).toBe(false)
    expect(isAgentCapabilityId(42)).toBe(false)
  })

  it("carries the 16 SDK-parity ids added by contract v2", () => {
    const sdkParity = [
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
    for (const id of sdkParity) expect(isAgentCapabilityId(id)).toBe(true)
    expect(AGENT_CAPABILITY_IDS).toHaveLength(40)
  })
})

describe("contract v2: capabilities.support", () => {
  const v2Spec: ResolvedAgentExecutionSpec = {
    ...validSpec,
    specVersion: 2,
    capabilities: {
      ...validSpec.capabilities,
      support: {
        streaming: { support: "native" },
        "tools.ordinary": { support: "native" },
      },
    },
  }

  it("accepts a v2 spec carrying verdicts", () => {
    expect(validateResolvedAgentExecutionSpec(v2Spec).ok).toBe(true)
  })

  it("requires support on a v2 spec", () => {
    const result = validateResolvedAgentExecutionSpec({
      ...validSpec,
      specVersion: 2,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toMatch(/support is required on a v2 spec/)
  })

  it("rejects support on a v1 spec", () => {
    const result = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      specVersion: 1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toMatch(/not valid on a v1 spec/)
  })

  it("makes a non-native verdict explain itself", () => {
    // An `unsupported` with no reason is indistinguishable from a half-written
    // adapter, which is exactly the ambiguity fail-closed exists to prevent.
    const result = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      capabilities: {
        ...v2Spec.capabilities,
        support: { streaming: { support: "unsupported" } },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toMatch(/must carry a reason/)
  })

  it("accepts `equivalent` when it explains how", () => {
    const result = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      capabilities: {
        ...v2Spec.capabilities,
        support: {
          streaming: { support: "native" },
          "output.structured": {
            support: "equivalent",
            reason: "provider-native JSON schema rather than the SDK outputFormat",
          },
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it("rejects unknown capability ids and unknown support values", () => {
    const unknownId = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      capabilities: {
        ...v2Spec.capabilities,
        support: { "tools.telepathy": { support: "native" } },
      },
    })
    expect(unknownId.ok).toBe(false)

    const unknownSupport = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      capabilities: { ...v2Spec.capabilities, support: { streaming: { support: "sort-of" } } },
    })
    expect(unknownSupport.ok).toBe(false)
  })
})

describe("upgradeResolvedAgentExecutionSpec", () => {
  it("upcasts v1 to v2 and marks the prior effective set native, with a reason", () => {
    const upgraded = upgradeResolvedAgentExecutionSpec(validSpec)
    expect(upgraded.specVersion).toBe(2)
    expect(upgraded.capabilities.support?.streaming?.support).toBe("native")
    expect(upgraded.capabilities.support?.["tools.ordinary"]?.support).toBe("native")
    expect(validateResolvedAgentExecutionSpec(upgraded).ok).toBe(true)
  })

  it("does not invent verdicts for the v2-only capabilities", () => {
    const upgraded = upgradeResolvedAgentExecutionSpec(validSpec)
    expect(upgraded.capabilities.support?.["session.store"]).toBeUndefined()
    expect(upgraded.capabilities.support?.["output.structured"]).toBeUndefined()
  })

  it("is idempotent", () => {
    const once = upgradeResolvedAgentExecutionSpec(validSpec)
    expect(upgradeResolvedAgentExecutionSpec(once)).toBe(once)
  })

  it("leaves every other field untouched", () => {
    const upgraded = upgradeResolvedAgentExecutionSpec(validSpec)
    const { specVersion: _v, capabilities: _c, ...restUpgraded } = upgraded
    const { specVersion: _v1, capabilities: _c1, ...restOriginal } = validSpec
    expect(restUpgraded).toEqual(restOriginal)
    expect(upgraded.capabilities.effective).toEqual(validSpec.capabilities.effective)
  })

  it("RESOLVED_SPEC_VERSION is what new specs are emitted as", () => {
    expect(RESOLVED_SPEC_VERSION).toBe(2)
  })
})
