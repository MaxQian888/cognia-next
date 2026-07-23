import {
  isHandoffEnvelope,
  validateHandoffEnvelope,
  type HandoffEnvelope,
} from "./handoff-envelope"

function validEnvelope(): HandoffEnvelope {
  return {
    envelopeVersion: 1,
    identity: {
      parentRunId: "run-parent",
      childRunId: "run-child",
      teamId: "team-1",
      taskId: "t1",
      depth: 1,
      parentChain: ["run-parent"],
    },
    task: { title: "Review", prompt: "Review the diff", expectedOutput: "verdict" },
    execution: {
      mode: "orchestrated",
      executionFingerprint: "fp-1",
      runtimeAdapter: "ai-sdk",
      deploymentRef: "dep-vendor-a",
      credentialProfileRef: "cred-profile-1",
      hostRef: "desktop-sidecar",
      modelRole: "fast",
    },
    budget: { maxTokens: 50_000 },
    resources: [{ kind: "workspace", ref: "ws:team-1:t1" }],
    createdAt: "2026-07-23T00:00:00.000Z",
  }
}

describe("validateHandoffEnvelope", () => {
  it("accepts a fully-populated valid envelope", () => {
    expect(validateHandoffEnvelope(validEnvelope())).toEqual([])
    expect(isHandoffEnvelope(validEnvelope())).toBe(true)
  })

  it("requires identity chain, task prompt, execution mode and timestamp", () => {
    const errors = validateHandoffEnvelope({ envelopeVersion: 1 })
    expect(errors).toEqual(
      expect.arrayContaining([
        "identity is required",
        "task.prompt is required",
        "execution is required",
        "createdAt must be an ISO timestamp",
      ])
    )
  })

  it("rejects depth 0 and non-integer depths (root children start at 1)", () => {
    const env = validEnvelope()
    env.identity.depth = 0
    expect(validateHandoffEnvelope(env)).toContain("identity.depth must be an integer >= 1")
    env.identity.depth = 1.5
    expect(validateHandoffEnvelope(env)).toContain("identity.depth must be an integer >= 1")
  })

  it("rejects secret-shaped values in every ref position", () => {
    for (const field of ["deploymentRef", "credentialProfileRef", "hostRef"] as const) {
      const env = validEnvelope()
      env.execution[field] = "sk-ant-abc123"
      const errors = validateHandoffEnvelope(env)
      expect(errors.some((e) => e.includes(field) && e.includes("secret-shaped"))).toBe(true)
    }
    const env = validEnvelope()
    env.resources = [{ kind: "workspace", ref: "my_api_key=abc" }]
    expect(validateHandoffEnvelope(env).some((e) => e.includes("secret-shaped"))).toBe(true)
  })

  it("rejects URL-shaped values in ref positions (endpoints live in profiles)", () => {
    const env = validEnvelope()
    env.execution.deploymentRef = "https://api.vendor.example/v1"
    expect(
      validateHandoffEnvelope(env).some(
        (e) => e.includes("deploymentRef") && e.includes("URL-shaped")
      )
    ).toBe(true)
  })

  it("rejects machine-local absolute paths as resource refs (posix and windows)", () => {
    const env = validEnvelope()
    env.resources = [{ kind: "workspace", ref: "/Users/alice/repo" }]
    expect(validateHandoffEnvelope(env).some((e) => e.includes("absolute path"))).toBe(true)
    env.resources = [{ kind: "workspace", ref: "C:\\repo" }]
    expect(validateHandoffEnvelope(env).some((e) => e.includes("absolute path"))).toBe(true)
  })

  it("rejects malformed identity chains, empty refs and non-ISO timestamps", () => {
    const env = validEnvelope()
    ;(env.identity as { parentChain: unknown }).parentChain = ["ok", 42]
    expect(validateHandoffEnvelope(env)).toContain("identity.parentChain must be a string array")

    const emptyRef = validEnvelope()
    ;(emptyRef.execution as { deploymentRef: unknown }).deploymentRef = ""
    expect(validateHandoffEnvelope(emptyRef)).toContain(
      "execution.deploymentRef must be a non-empty string"
    )

    const badTs = validEnvelope()
    badTs.createdAt = "not-a-date"
    expect(validateHandoffEnvelope(badTs)).toContain("createdAt must be an ISO timestamp")

    const badRes = validEnvelope()
    ;(badRes.resources as unknown[]) = [{ kind: "", ref: "x" }]
    expect(validateHandoffEnvelope(badRes)).toContain("resources[0] must have kind and ref")

    expect(validateHandoffEnvelope(null)).toEqual(["envelope must be an object"])
    expect(isHandoffEnvelope(badTs)).toBe(false)
  })

  it("rejects a wrong envelopeVersion and a bad execution mode", () => {
    const env = validEnvelope() as unknown as Record<string, unknown>
    env.envelopeVersion = 2
    expect(validateHandoffEnvelope(env)).toContain("envelopeVersion must be 1")
    const badMode = validEnvelope()
    ;(badMode.execution as { mode: string }).mode = "detached"
    expect(validateHandoffEnvelope(badMode)).toContain(
      'execution.mode must be "native" or "orchestrated"'
    )
  })
})
