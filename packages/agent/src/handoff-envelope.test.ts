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
      taskId: "task-1",
      depth: 1,
      parentChain: ["run-parent"],
    },
    task: { title: "Review", prompt: "Review the diff", expectedOutput: "verdict" },
    execution: {
      mode: "orchestrated",
      executionFingerprint: "fp-1",
      runtimeAdapter: "ai-sdk",
      deploymentRef: "deployment:vendor-a",
      credentialProfileRef: "credential:vendor-a",
      hostRef: "device:worker-a",
      modelRole: "fast",
    },
    budget: { maxTokens: 50_000 },
    resources: [{ kind: "repository", ref: "repository:project-1:repo-1" }],
    createdAt: "2026-08-12T00:00:00.000Z",
  }
}

describe("HandoffEnvelope", () => {
  it("accepts a stable ref-only worker handoff", () => {
    expect(validateHandoffEnvelope(validEnvelope())).toEqual([])
    expect(isHandoffEnvelope(validEnvelope())).toBe(true)
  })

  it("rejects credentials, URLs, and host-local paths in ref positions", () => {
    const secret = validEnvelope()
    secret.execution.credentialProfileRef = "sk-secret"
    expect(validateHandoffEnvelope(secret)).toContain(
      "execution.credentialProfileRef: secret-shaped value in a ref position"
    )

    const url = validEnvelope()
    url.execution.deploymentRef = "https://provider.example/v1"
    expect(validateHandoffEnvelope(url)).toContain(
      "execution.deploymentRef: URL-shaped value in a ref position"
    )

    const path = validEnvelope()
    path.resources = [{ kind: "repository", ref: "/Users/alice/repository" }]
    expect(validateHandoffEnvelope(path)).toContain(
      "resources[0].ref: machine-local absolute path is not a stable ref"
    )
  })
})
