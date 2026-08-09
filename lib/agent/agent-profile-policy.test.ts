import type { AgentEnvBinding, AgentExecutionPolicy, Character } from "@cognia/agent-config-types"
import {
  AgentEnvironmentError,
  isValidAgentEnvName,
  mergeAgentEnvBindings,
  resolveAgentEnvironment,
  resolveAgentExecutionPolicy,
  resolveAgentModel,
} from "./agent-profile-policy"

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: "agent-1",
    name: "Agent",
    avatarColor: "#000",
    systemPrompt: "Help",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("resolveAgentModel", () => {
  it("keeps legacy Character.model as the execute model only", () => {
    const agent = character({ model: "legacy-model" })

    expect(resolveAgentModel("execute", agent, "app-default")).toBe("legacy-model")
    expect(resolveAgentModel("plan", agent, "app-default")).toBe("app-default")
    expect(resolveAgentModel("utility", agent, "app-default")).toBe("app-default")
  })

  it("uses the semantic model target for the requested role", () => {
    const agent = character({
      model: "legacy-model",
      modelRouting: {
        plan: "planner-alias",
        execute: "executor-alias",
        utility: "fast-alias",
      },
    })

    expect(resolveAgentModel("plan", agent, "app-default")).toBe("planner-alias")
    expect(resolveAgentModel("execute", agent, "app-default")).toBe("executor-alias")
    expect(resolveAgentModel("utility", agent, "app-default")).toBe("fast-alias")
  })

  it("ignores blank persisted targets", () => {
    const agent = character({ modelRouting: { execute: "  " } })
    expect(resolveAgentModel("execute", agent, "app-default")).toBe("app-default")
  })
})

describe("Agent execution policy", () => {
  const agentPolicy: AgentExecutionPolicy = {
    effort: "medium",
    maxTurns: 20,
    envBindings: [
      { name: "PLAIN", kind: "plain", value: "agent" },
      { name: "SECRET", kind: "secret", secretRef: "agent-1:SECRET" },
    ],
  }

  it("applies session overrides without mutating either source", () => {
    const sessionPolicy: AgentExecutionPolicy = {
      effort: "high",
      maxTurns: 8,
      envBindings: [
        { name: "PLAIN", kind: "plain", value: "session" },
        { name: "SESSION_ONLY", kind: "plain", value: "yes" },
      ],
    }

    expect(resolveAgentExecutionPolicy(agentPolicy, sessionPolicy)).toEqual({
      effort: "high",
      maxTurns: 8,
      envBindings: [
        { name: "SECRET", kind: "secret", secretRef: "agent-1:SECRET" },
        { name: "PLAIN", kind: "plain", value: "session" },
        { name: "SESSION_ONLY", kind: "plain", value: "yes" },
      ],
    })
    expect(agentPolicy.envBindings?.[0]).toEqual({ name: "PLAIN", kind: "plain", value: "agent" })
  })

  it.each([0, 101, 1.5])("rejects invalid maxTurns %p", (maxTurns) => {
    expect(() => resolveAgentExecutionPolicy({ maxTurns }, undefined)).toThrow(
      "maxTurns must be an integer between 1 and 100"
    )
  })
})

describe("Agent environment bindings", () => {
  it.each([
    ["API_TOKEN", true],
    ["_PRIVATE", true],
    ["9INVALID", false],
    ["BAD-NAME", false],
  ])("validates environment name %s", (name, expected) => {
    expect(isValidAgentEnvName(name)).toBe(expected)
  })

  it("deduplicates by name with later bindings winning", () => {
    const merged = mergeAgentEnvBindings(
      [{ name: "A", kind: "plain", value: "agent" }],
      [
        { name: "A", kind: "plain", value: "session" },
        { name: "B", kind: "plain", value: "two" },
      ]
    )
    expect(merged).toEqual([
      { name: "A", kind: "plain", value: "session" },
      { name: "B", kind: "plain", value: "two" },
    ])
  })

  it("resolves secrets only through the injected keyring reader", async () => {
    const bindings: AgentEnvBinding[] = [
      { name: "PUBLIC", kind: "plain", value: "visible" },
      { name: "TOKEN", kind: "secret", secretRef: "agent-1:TOKEN" },
    ]
    const readSecret = jest.fn(async () => "hidden")

    await expect(resolveAgentEnvironment(bindings, readSecret)).resolves.toEqual({
      PUBLIC: "visible",
      TOKEN: "hidden",
    })
    expect(readSecret).toHaveBeenCalledWith("agent-1:TOKEN")
  })

  it("fails closed with the variable name when a secret is missing", async () => {
    const bindings: AgentEnvBinding[] = [
      { name: "API_TOKEN", kind: "secret", secretRef: "agent-1:API_TOKEN" },
    ]

    await expect(resolveAgentEnvironment(bindings, async () => null)).rejects.toEqual(
      expect.objectContaining<Partial<AgentEnvironmentError>>({
        name: "AgentEnvironmentError",
        code: "secret_missing",
        variableName: "API_TOKEN",
      })
    )
  })

  it("rejects invalid environment names before reading any secret", async () => {
    const readSecret = jest.fn(async () => "hidden")
    await expect(
      resolveAgentEnvironment([{ name: "BAD-NAME", kind: "secret", secretRef: "ref" }], readSecret)
    ).rejects.toMatchObject({ code: "invalid_name", variableName: "BAD-NAME" })
    expect(readSecret).not.toHaveBeenCalled()
  })
})
