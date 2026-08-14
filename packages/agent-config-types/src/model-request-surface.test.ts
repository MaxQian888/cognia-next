import {
  MODEL_REQUEST_SURFACE_SCHEMA_VERSION,
  REPLAY_ARTIFACT_KINDS,
  REPLAY_SCENARIO_SCHEMA_VERSION,
  REPLAY_TAPE_SCHEMA_VERSION,
  findAmbiguousTapes,
  isReplayArtifactKind,
  requestDigestPayload,
  validateModelRequestSurface,
  validateReplayScenario,
  validateReplayTape,
} from "./model-request-surface"
import type { ModelRequestSurfaceV1, ReplayScenarioV1, ReplayTapeV1 } from "./model-request-surface"

const PROMPT = `sha256:${"1".repeat(64)}`
const MESSAGES = `sha256:${"2".repeat(64)}`
const TOOLS = `sha256:${"3".repeat(64)}`
const REQUEST = `sha256:${"4".repeat(64)}`

function surface(overrides: Partial<ModelRequestSurfaceV1> = {}): ModelRequestSurfaceV1 {
  return {
    schemaVersion: MODEL_REQUEST_SURFACE_SCHEMA_VERSION,
    sessionId: "s1",
    runId: "r1",
    turnId: "t1",
    attemptId: "a1",
    runtimeAdapter: "claude-agent-sdk",
    provider: "anthropic",
    model: "claude-opus-5",
    purpose: "turn",
    config: { temperature: 0, stream: true },
    promptDigest: PROMPT,
    messagesDigest: MESSAGES,
    toolDigest: TOOLS,
    requestDigest: REQUEST,
    recordedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  }
}

function tape(overrides: Partial<ReplayTapeV1> = {}): ReplayTapeV1 {
  return {
    schemaVersion: REPLAY_TAPE_SCHEMA_VERSION,
    tapeId: "tape-1",
    match: { actorRef: "root", purpose: "turn", requestDigest: REQUEST },
    behavior: { kind: "stream", chunksRef: "asset-1" },
    synthetic: true,
    ...overrides,
  }
}

function scenario(overrides: Partial<ReplayScenarioV1> = {}): ReplayScenarioV1 {
  return {
    schemaVersion: REPLAY_SCENARIO_SCHEMA_VERSION,
    scenarioId: "sc-1",
    title: "plain text turn",
    level: "runtime",
    platform: "headless",
    actors: [{ actorRef: "root", role: "root" }],
    inputSteps: [{ kind: "prompt", actorRef: "root", text: "hello" }],
    permissionScript: [],
    expectations: { assertConsumed: true, fidelity: "full" },
    ...overrides,
  }
}

describe("replay artifact kinds", () => {
  it("covers the six kinds added to the eval asset store", () => {
    expect(REPLAY_ARTIFACT_KINDS).toEqual([
      "model-request",
      "model-stream",
      "permission-tape",
      "session-log",
      "transport",
      "workspace-manifest",
    ])
    for (const kind of REPLAY_ARTIFACT_KINDS) expect(isReplayArtifactKind(kind)).toBe(true)
    expect(isReplayArtifactKind("prompt")).toBe(false)
    expect(isReplayArtifactKind(null)).toBe(false)
  })
})

describe("requestDigestPayload", () => {
  it("is identical across sessions, runs and record times", () => {
    const first = requestDigestPayload(surface())
    const second = requestDigestPayload(
      surface({
        sessionId: "s2",
        runId: "r2",
        turnId: "t2",
        attemptId: "a2",
        recordedAt: "2027-01-01T00:00:00.000Z",
      })
    )
    expect(second).toEqual(first)
  })

  it("separates purposes so a title call cannot consume a turn tape", () => {
    expect(requestDigestPayload(surface({ purpose: "title" }))).not.toEqual(
      requestDigestPayload(surface())
    )
  })

  it("changes when the resolved config changes", () => {
    expect(requestDigestPayload(surface({ config: { temperature: 1 } }))).not.toEqual(
      requestDigestPayload(surface())
    )
  })

  it("changes when the tool list changes", () => {
    expect(requestDigestPayload(surface({ toolDigest: PROMPT }))).not.toEqual(
      requestDigestPayload(surface())
    )
  })
})

describe("validateModelRequestSurface", () => {
  it("accepts a surface without artifact refs", () => {
    // The ordinary, non-recording path: digests present, bodies absent.
    const result = validateModelRequestSurface(surface())
    expect(result.ok).toBe(true)
  })

  it("accepts a surface with artifact refs", () => {
    const result = validateModelRequestSurface(
      surface({ refs: { promptRef: "a", messagesRef: "b", toolSchemaRef: "c" } })
    )
    expect(result.ok).toBe(true)
  })

  it("rejects an unknown purpose", () => {
    const result = validateModelRequestSurface(surface({ purpose: "warmup" as never }))
    expect(result.ok).toBe(false)
  })

  it("rejects a truncated digest", () => {
    const result = validateModelRequestSurface(surface({ requestDigest: "sha256:abc" }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("requestDigest must be a sha256:<64 hex> digest")
  })

  it("rejects a missing identity field", () => {
    const result = validateModelRequestSurface(surface({ runId: "" }))
    expect(result.ok).toBe(false)
  })

  it("rejects a non-object", () => {
    expect(validateModelRequestSurface(undefined).ok).toBe(false)
  })

  it("names each malformed field", () => {
    const cases: Array<[Partial<ModelRequestSurfaceV1>, string]> = [
      [{ schemaVersion: 2 as never }, "schemaVersion must be 1"],
      [{ sessionId: "" }, "sessionId must be a non-empty string"],
      [{ turnId: 3 as never }, "turnId must be a non-empty string"],
      [{ attemptId: "" }, "attemptId must be a non-empty string"],
      [{ provider: "" }, "provider must be a non-empty string"],
      [{ model: "" }, "model must be a non-empty string"],
      [{ config: null as never }, "config must be an object"],
      [{ promptDigest: "nope" }, "promptDigest must be a sha256:<64 hex> digest"],
      [{ messagesDigest: "nope" }, "messagesDigest must be a sha256:<64 hex> digest"],
      [{ toolDigest: "nope" }, "toolDigest must be a sha256:<64 hex> digest"],
      [{ recordedAt: "" }, "recordedAt must be a non-empty string"],
    ]

    for (const [override, expected] of cases) {
      const result = validateModelRequestSurface(surface(override))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error(`expected failure for ${expected}`)
      expect(result.errors).toContain(expected)
    }
  })
})

describe("validateReplayTape", () => {
  it("accepts each behaviour kind", () => {
    expect(validateReplayTape(tape()).ok).toBe(true)
    expect(
      validateReplayTape(tape({ behavior: { kind: "error", code: "overloaded", message: "busy" } }))
        .ok
    ).toBe(true)
    expect(validateReplayTape(tape({ behavior: { kind: "cancel", afterChunks: 2 } })).ok).toBe(true)
    expect(validateReplayTape(tape({ behavior: { kind: "hang", holdMs: 1000 } })).ok).toBe(true)
  })

  it("rejects an unknown behaviour kind", () => {
    const result = validateReplayTape(tape({ behavior: { kind: "reply" } as never }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("behavior.kind must be one of stream|error|cancel|hang")
  })

  it("rejects a negative hang", () => {
    expect(validateReplayTape(tape({ behavior: { kind: "hang", holdMs: -1 } })).ok).toBe(false)
  })

  it("rejects a stream tape with no chunk reference", () => {
    expect(validateReplayTape(tape({ behavior: { kind: "stream", chunksRef: "" } })).ok).toBe(false)
  })

  it("requires an explicit synthetic verdict", () => {
    const { synthetic: _synthetic, ...withoutVerdict } = tape()
    const result = validateReplayTape(withoutVerdict)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("synthetic must be a boolean")
  })

  it("rejects a malformed match", () => {
    const result = validateReplayTape(
      tape({ match: { actorRef: "", purpose: "warmup" as never, requestDigest: "nope" } })
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toEqual([
      "match.actorRef must be a non-empty string",
      `match.purpose must be one of ${["turn", "subagent", "compaction", "title", "summary", "judge", "embedding", "other"].join("|")}`,
      "match.requestDigest must be a sha256:<64 hex> digest",
    ])
  })

  it("names each remaining malformed field", () => {
    const cases: Array<[Partial<ReplayTapeV1>, string]> = [
      [{ schemaVersion: 9 as never }, "schemaVersion must be 1"],
      [{ tapeId: "" }, "tapeId must be a non-empty string"],
      [{ match: null as never }, "match must be an object"],
      [{ behavior: "stream" as never }, "behavior must be an object"],
      [
        { behavior: { kind: "error", code: "", message: "x" } },
        "behavior.code must be a non-empty string",
      ],
      [
        { behavior: { kind: "error", code: "c", message: 4 as never } },
        "behavior.message must be a string",
      ],
      [
        { behavior: { kind: "cancel", afterChunks: "two" as never } },
        "behavior.afterChunks must be a number when present",
      ],
      [
        { behavior: { kind: "hang", holdMs: "soon" as never } },
        "behavior.holdMs must be a non-negative number",
      ],
    ]

    for (const [override, expected] of cases) {
      const result = validateReplayTape(tape(override))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error(`expected failure for ${expected}`)
      expect(result.errors).toContain(expected)
    }
  })

  it("rejects a non-object", () => {
    expect(validateReplayTape(null).ok).toBe(false)
  })
})

describe("findAmbiguousTapes", () => {
  it("allows a repeated question answered the same way twice", () => {
    expect(findAmbiguousTapes([tape({ tapeId: "a" }), tape({ tapeId: "b" })])).toEqual([])
  })

  it("flags one key with two different answers", () => {
    const conflicts = findAmbiguousTapes([
      tape({ tapeId: "a" }),
      tape({ tapeId: "b", behavior: { kind: "error", code: "overloaded", message: "busy" } }),
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toContain("root")
  })

  it("does not confuse two actors asking the same question", () => {
    const child = tape({
      tapeId: "c",
      match: { actorRef: "child-1", purpose: "turn", requestDigest: REQUEST },
      behavior: { kind: "cancel" },
    })
    expect(findAmbiguousTapes([tape(), child])).toEqual([])
  })

  it("does not confuse two purposes with the same digest", () => {
    const title = tape({
      tapeId: "t",
      match: { actorRef: "root", purpose: "title", requestDigest: REQUEST },
      behavior: { kind: "cancel" },
    })
    expect(findAmbiguousTapes([tape(), title])).toEqual([])
  })

  it("returns nothing for an empty set", () => {
    expect(findAmbiguousTapes([])).toEqual([])
  })
})

describe("validateReplayScenario", () => {
  it("accepts a runtime scenario on a headless host", () => {
    expect(validateReplayScenario(scenario()).ok).toBe(true)
  })

  it("accepts canonical replay in a browser", () => {
    expect(validateReplayScenario(scenario({ level: "canonical", platform: "browser" })).ok).toBe(
      true
    )
  })

  it("refuses runtime replay in a browser", () => {
    const result = validateReplayScenario(scenario({ level: "runtime", platform: "browser" }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("runtime replay requires a tauri or headless platform")
  })

  it("accepts a declared parent/child pair", () => {
    const result = validateReplayScenario(
      scenario({
        actors: [
          { actorRef: "root", role: "root" },
          { actorRef: "child-1", role: "child", parentActorRef: "root" },
        ],
      })
    )
    expect(result.ok).toBe(true)
  })

  it("rejects a child with no parent", () => {
    const result = validateReplayScenario(
      scenario({
        actors: [
          { actorRef: "root", role: "root" },
          { actorRef: "child-1", role: "child" },
        ],
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("child actor child-1 must name a parentActorRef")
  })

  it("rejects a parent reference that names nobody", () => {
    const result = validateReplayScenario(
      scenario({
        actors: [
          { actorRef: "root", role: "root" },
          { actorRef: "child-1", role: "child", parentActorRef: "ghost" },
        ],
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("actor child-1 names an unknown parentActorRef ghost")
  })

  it("rejects duplicate actor refs", () => {
    const result = validateReplayScenario(
      scenario({
        actors: [
          { actorRef: "root", role: "root" },
          { actorRef: "root", role: "root" },
        ],
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("duplicate actorRef root")
  })

  it("rejects an empty actor list", () => {
    expect(validateReplayScenario(scenario({ actors: [] })).ok).toBe(false)
  })

  it("rejects an unknown fidelity", () => {
    const result = validateReplayScenario(
      scenario({ expectations: { assertConsumed: true, fidelity: "partial" as never } })
    )
    expect(result.ok).toBe(false)
  })

  it("rejects malformed step and permission collections", () => {
    const result = validateReplayScenario(
      scenario({ inputSteps: "hello" as never, permissionScript: 3 as never })
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("inputSteps must be an array")
    expect(result.errors).toContain("permissionScript must be an array")
  })

  it.each([
    [
      { inputSteps: [{ kind: "prompt", actorRef: "root", text: 42 }] as never },
      "inputSteps[0].text must be a string",
    ],
    [
      { inputSteps: [{ kind: "cancel", actorRef: "root", afterMs: -1 }] as never },
      "inputSteps[0].afterMs must be a non-negative number when present",
    ],
    [
      { inputSteps: [{ kind: "resume", actorRef: "ghost" }] as never },
      "inputSteps[0] names unknown actorRef ghost",
    ],
    [
      { inputSteps: [{ kind: "unknown", actorRef: "root" }] as never },
      "inputSteps[0].kind must be one of prompt|cancel|resume",
    ],
    [
      { permissionScript: [{ actorRef: "root", toolName: "Read", decision: "maybe" }] as never },
      "permissionScript[0].decision must be one of allow|deny|allow-always",
    ],
    [
      { permissionScript: [{ actorRef: "ghost", toolName: "Read", decision: "allow" }] as never },
      "permissionScript[0] names unknown actorRef ghost",
    ],
  ])("rejects malformed scenario members", (override, expected) => {
    const result = validateReplayScenario(scenario(override))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain(expected)
  })

  it("rejects a non-object", () => {
    expect(validateReplayScenario(42).ok).toBe(false)
  })

  it("names each remaining malformed field", () => {
    const cases: Array<[Partial<ReplayScenarioV1>, string]> = [
      [{ schemaVersion: 4 as never }, "schemaVersion must be 1"],
      [{ scenarioId: "" }, "scenarioId must be a non-empty string"],
      [{ title: 8 as never }, "title must be a non-empty string"],
      [{ level: "shadow" as never }, "level must be one of canonical|runtime"],
      [{ platform: "android" as never }, "platform must be one of browser|tauri|headless"],
      [{ actors: "root" as never }, "actors must be a non-empty array"],
      [{ actors: [{ role: "root" }] as never }, "each actor must have a non-empty actorRef"],
      [
        { actors: [{ actorRef: "root", role: "peer" }] as never },
        "actor root role must be root|child",
      ],
      [{ expectations: null as never }, "expectations must be an object"],
      [
        {
          expectations: { assertConsumed: "yes" as never, fidelity: "full" },
        },
        "expectations.assertConsumed must be a boolean",
      ],
    ]

    for (const [override, expected] of cases) {
      const result = validateReplayScenario(scenario(override))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error(`expected failure for ${expected}`)
      expect(result.errors).toContain(expected)
    }
  })
})
