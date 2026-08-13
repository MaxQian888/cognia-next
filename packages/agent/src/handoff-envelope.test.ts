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
      modelBindingRef: "model:fast",
      requiredCapabilities: ["streaming", "tools.ordinary"],
      requiredSandboxCapabilities: ["filesystem"],
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

  it("rejects malformed incremental execution requirements", () => {
    const envelope = validEnvelope()
    envelope.execution.requiredCapabilities = [""]
    expect(validateHandoffEnvelope(envelope)).toContain(
      "execution.requiredCapabilities must be a non-empty string array"
    )
    envelope.execution.requiredSandboxCapabilities = [""]
    expect(validateHandoffEnvelope(envelope)).toContain(
      "execution.requiredSandboxCapabilities must be a non-empty string array"
    )
  })

  it("reports malformed required sections and ref shapes without throwing", () => {
    expect(validateHandoffEnvelope(null)).toEqual(["envelope must be an object"])
    expect(isHandoffEnvelope({})).toBe(false)

    const errors = validateHandoffEnvelope({
      envelopeVersion: 2,
      identity: {
        parentRunId: "",
        childRunId: "",
        depth: 1.5,
        parentChain: [""],
      },
      task: { prompt: "" },
      execution: {
        mode: "invalid",
        deploymentRef: "",
        credentialProfileRef: "token=secret",
        hostRef: "https://worker.example",
        modelBindingRef: "model:valid",
        requiredCapabilities: "streaming",
        requiredSandboxCapabilities: "filesystem",
      },
      resources: [
        null,
        { kind: "", ref: "" },
        { kind: "repository", ref: "https://repository.example" },
        { kind: "repository", ref: "C:\\repository" },
      ],
      createdAt: "not-a-date",
    })

    expect(errors).toEqual(
      expect.arrayContaining([
        "envelopeVersion must be 1",
        "identity.parentRunId is required",
        "identity.childRunId is required",
        "identity.depth must be an integer >= 1",
        "identity.parentChain must be a string array",
        "task.prompt is required",
        'execution.mode must be "native" or "orchestrated"',
        "execution.deploymentRef must be a non-empty string",
        "execution.credentialProfileRef: secret-shaped value in a ref position",
        "execution.hostRef: URL-shaped value in a ref position",
        "execution.requiredCapabilities must be a non-empty string array",
        "execution.requiredSandboxCapabilities must be a non-empty string array",
        "resources[0] must have kind and ref",
        "resources[1] must have kind and ref",
        "resources[2].ref: URL-shaped value in a ref position",
        "resources[3].ref: machine-local absolute path is not a stable ref",
        "createdAt must be an ISO timestamp",
      ])
    )
    expect(validateHandoffEnvelope({ ...validEnvelope(), identity: undefined })).toContain(
      "identity is required"
    )
    expect(validateHandoffEnvelope({ ...validEnvelope(), execution: undefined })).toContain(
      "execution is required"
    )
  })
})
