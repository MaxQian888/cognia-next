import {
  BestOfNAgentChoiceError,
  bestOfNAgentOptions,
  describeBestOfNAgent,
  resolveBestOfNAgentChoices,
  splitAgentsFlag,
} from "./agents"

const session = { characterId: "char", model: "sonnet", providerOverride: "anthropic" }
const configs = [
  {
    id: "codex-new",
    name: "Codex (new)",
    enabled: true,
    metadata: { preset: "codex-app-server" },
    createdAt: 2,
  },
  { id: "codex-old", name: "Codex", enabled: true, metadata: { preset: "codex" }, createdAt: 1 },
  {
    id: "claude-off",
    name: "Claude Code",
    enabled: false,
    metadata: { preset: "claude-code" },
    createdAt: 1,
  },
  {
    id: "claude-gw",
    name: "Claude via gateway",
    enabled: true,
    metadata: { preset: "claude-code" },
    createdAt: 3,
    cogniaModel: { providerId: "p", modelId: "m" },
  },
]

it("offers the conversation agent and only enabled external configurations", () => {
  expect(bestOfNAgentOptions(configs, true).map((option) => option.value)).toEqual([
    "session",
    "codex-old",
    "codex-new",
    "claude-gw",
  ])
  expect(bestOfNAgentOptions(configs, false)).toEqual([
    { value: "session", kind: "session", label: "session" },
  ])
})

it("resolves session, exact ids and preset families without substituting another agent", () => {
  expect(
    resolveBestOfNAgentChoices(session, ["session", "codex", "claude-gw"], configs, true)
  ).toEqual([
    { agentId: "char", model: "sonnet", provider: "anthropic" },
    { agentId: "char", provider: "cognia:external-agent:codex-old" },
    { agentId: "char", provider: "cognia:external-agent:claude-gw" },
  ])
  // A disabled config and a gateway-bound one are never picked for a bare preset.
  expect(() => resolveBestOfNAgentChoices(session, ["claude-code"], configs, true)).toThrow(
    BestOfNAgentChoiceError
  )
  expect(() => resolveBestOfNAgentChoices(session, ["codex"], configs, false)).toThrow(
    'No enabled agent matches "codex"'
  )
})

it("splits a leading --agents flag in either spelling", () => {
  expect(splitAgentsFlag("--agents claude-code,codex fix the bug")).toEqual({
    agents: ["claude-code", "codex"],
    rest: "fix the bug",
  })
  expect(splitAgentsFlag("--agents=session,codex")).toEqual({
    agents: ["session", "codex"],
    rest: "",
  })
  expect(splitAgentsFlag("--agents a,,b x").agents).toEqual([])
  expect(splitAgentsFlag("fix --agents a")).toEqual({ agents: null, rest: "fix --agents a" })
})

it("describes which runtime a recorded candidate used", () => {
  expect(
    describeBestOfNAgent({ agentId: "char", provider: "cognia:external-agent:codex-1" })
  ).toEqual({
    kind: "external",
    configId: "codex-1",
  })
  expect(describeBestOfNAgent({ agentId: "char", provider: "cognia:external-agent" })).toEqual({
    kind: "external",
    configId: null,
  })
  expect(describeBestOfNAgent({ agentId: "char", provider: "anthropic" })).toEqual({
    kind: "cognia",
    agentId: "char",
  })
})
