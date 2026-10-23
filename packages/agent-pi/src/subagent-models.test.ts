import {
  decodePiSubagentRouting,
  routePiSubagentCall,
  withPiSubagentExtensions,
  PI_SUBAGENT_MODELS_ENV,
} from "./subagent-models"
const routing = {
  family: "nico" as const,
  packageDir: "/pkg",
  agents: { reviewer: "cognia/review", worker: null },
  sources: {},
  defaultModel: "cognia/cheap",
  allowedModels: ["cognia/main", "cognia/review", "cognia/cheap"],
  providerId: "deepseek",
  cwd: "/repo",
}

it("preserves explicit agent models and fills only omissions in single, parallel and chain launches", () => {
  const input = {
    tasks: [{ agent: "reviewer", model: "cognia/cheap" }, { agent: "worker" }],
    chain: [{ agent: "worker", model: "cognia/main" }],
  }
  routePiSubagentCall(input, routing)
  expect(input.tasks.map((task) => task.model)).toEqual(["cognia/review", "cognia/cheap"])
  expect(input.chain[0].model).toBe("cognia/main")
})
it("supports the installed Gotgenes call schema and case-insensitive agent names", () => {
  const input = { subagent_type: "Reviewer" }
  routePiSubagentCall(input, { ...routing, family: "gotgenes" })
  expect(input).toEqual({ subagent_type: "Reviewer", model: "cognia/review" })
})
it("rejects unadmitted calls atomically", () => {
  const input = { tasks: [{ agent: "worker" }, { agent: "worker", model: "openai/other" }] }
  expect(() => routePiSubagentCall(input, routing)).toThrow(/not admitted/)
  expect(input.tasks[0]).toEqual({ agent: "worker" })
})

it("keeps explicit inheritance tied to the current parent, including nested parents", () => {
  const input = { agent: "parent" }
  routePiSubagentCall(input, { ...routing, agents: { parent: "inherit" } }, "cognia/review")
  expect(input).toEqual({ agent: "parent", model: "cognia/review" })
  expect(() =>
    routePiSubagentCall(
      { agent: "parent" },
      { ...routing, agents: { parent: "inherit" } },
      "other/native"
    )
  ).toThrow(/not admitted/)
})
it.each([
  { agent: "worker", cwd: "/other" },
  { agent: "worker", agentScope: "user" },
  { action: "schedule" },
])("refuses launch semantics outside the admitted snapshot", (input) => {
  expect(() => routePiSubagentCall(input, routing)).toThrow()
})
it("uses the existing provider alias only for admitted models", () => {
  const input = { agent: "worker", model: "deepseek/main" }
  routePiSubagentCall(input, routing)
  expect(input.model).toBe("cognia/main")
})
it("does not enable routing for missing config and rejects invalid serialized config", () => {
  expect(decodePiSubagentRouting(undefined)).toBeUndefined()
  expect(() => decodePiSubagentRouting("{}")).toThrow()
})
it("stages only task-owned extension settings and retains other settings", () => {
  const env = {
    [PI_SUBAGENT_MODELS_ENV]: JSON.stringify(routing),
    COGNIA_GATEWAY_TASK_CONFIG: JSON.stringify({
      runtime: "pi",
      files: { "pi/settings.json": JSON.stringify({ defaultModel: "main" }) },
    }),
  }
  const next = withPiSubagentExtensions(env, ["/pkg/index.js"], "/verified/guard.ts")
  expect(JSON.parse(JSON.parse(next.COGNIA_GATEWAY_TASK_CONFIG).files["pi/settings.json"])).toEqual(
    { defaultModel: "main", extensions: ["/pkg/index.js", "/verified/guard.ts"] }
  )
  expect(env).not.toEqual(next)
})

it("honors Gotgenes per-call models for agents with omitted file models", () => {
  const input = { subagent_type: "worker", model: "cognia/review" }
  routePiSubagentCall(input, { ...routing, family: "gotgenes" })
  expect(input.model).toBe("cognia/review")
})
it.each([
  { workflow: true },
  { workflow: "review.ts" },
  { chain: "named" },
  { resume: "run-1" },
  { agent: "new-agent" },
])("rejects unmanaged or stale launch forms", (input) => {
  expect(() => routePiSubagentCall(input, routing)).toThrow()
})

it("prefers Gotgenes exact keys before case-insensitive fallback", () => {
  const input = { subagent_type: "Reviewer" }
  routePiSubagentCall(input, {
    ...routing,
    family: "gotgenes",
    agents: { reviewer: "cognia/review", Reviewer: null },
  })
  expect(input).toEqual({ subagent_type: "Reviewer", model: "cognia/cheap" })
})
