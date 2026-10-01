import {
  applyBootstrapProvider,
  applyBootstrapRecipe,
  applyBootstrapTaskPreset,
  BOOTSTRAP_PRESETS,
} from "./bootstrap-presets"
import { assertBootstrapAgent } from "./bootstrap-agent"
import type { ProjectEnvironmentBootstrapAgent } from "@/types/project-environment"
import en from "@/i18n/messages/en/projectEnvironment.json"
import zh from "@/i18n/messages/zh-CN/projectEnvironment.json"

const initial: ProjectEnvironmentBootstrapAgent = {
  enabled: true,
  runtime: "bash",
  binary: "/custom/agent.sh",
  task: "Keep this task",
  baseUrl: "https://old.example.com",
  model: "old-model",
  apiKeyEnv: "OLD_KEY",
  checks: [{ name: "ready", command: "true" }],
  tools: { shellExecutable: "/custom/bash", environment: { COLOR: "off" } },
  context: { contextWindowTokens: 32000 },
  modelOptions: {
    auth: "header",
    apiKeyHeader: "X-Old-Key",
    headersEnv: { "X-Old-Token": "OLD_TOKEN" },
    headers: { "X-Old-Project": "previous" },
    endpointPath: "/custom/completions",
    thinking: { type: "enabled" },
    extraBody: { previous: true },
    seed: 23,
    temperature: 0.3,
  },
  advancedOptionsDraft: '{"modelOptions":{"headersEnv":',
}

it.each(BOOTSTRAP_PRESETS.providers)("replaces the full provider transport for $id", (provider) => {
  const result = applyBootstrapProvider(initial, provider.id)
  expect(result).toMatchObject({
    baseUrl: provider.config.model.baseUrl,
    model: provider.config.model.model,
    apiKeyEnv: provider.config.model.apiKeyEnv,
    modelOptions: { auth: provider.config.model.auth },
    runtime: "bash",
    binary: "/custom/agent.sh",
    tools: initial.tools,
    checks: initial.checks,
    context: initial.context,
    task: initial.task,
  })
  expect(result.modelOptions).toEqual({ auth: provider.config.model.auth })
  expect(result.advancedOptionsDraft).toBeUndefined()
  expect(() => assertBootstrapAgent(result)).not.toThrow()
  expect(initial.modelOptions?.headersEnv).toEqual({ "X-Old-Token": "OLD_TOKEN" })
})

it.each(BOOTSTRAP_PRESETS.presets)("maps every task field for $id", (preset) => {
  const result = applyBootstrapTaskPreset(initial, preset.id)
  expect(result).toMatchObject({
    task: preset.config.task,
    tools: { ...initial.tools, ...preset.config.tools },
    modelOptions: { ...initial.modelOptions, ...preset.config.model },
    ...preset.config.limits,
  })
  expect(result.baseUrl).toBe(initial.baseUrl)
  expect(result.checks).toEqual(initial.checks)
})

it.each(BOOTSTRAP_PRESETS.recipes)("returns setup and complete recipe fields for $id", (recipe) => {
  const result = applyBootstrapRecipe(initial, recipe.id)
  expect(result.setupScript).toEqual({ default: recipe.config.setupCommand, byOs: {} })
  expect(result.bootstrapAgent).toMatchObject({
    task: recipe.config.task,
    checks: recipe.config.checks,
    reuse: recipe.config.reuse,
    ...recipe.config.limits,
  })
  expect(result.bootstrapAgent.modelOptions).toEqual(initial.modelOptions)
})

it("uses the resolved shell dialect and retains custom executable settings", () => {
  const ps = { ...initial, runtime: "powershell" as const, tools: undefined }
  const recipe = BOOTSTRAP_PRESETS.recipes.find((entry) => entry.id === "python-uv")!
  expect(applyBootstrapRecipe(ps, recipe.id).bootstrapAgent.checks).toEqual(
    recipe.powershell!.checks
  )
  expect(
    applyBootstrapRecipe({ ...ps, tools: { shellExecutable: "/bin/bash" } }, recipe.id)
      .bootstrapAgent.checks
  ).toEqual(recipe.config.checks)
  expect(
    applyBootstrapRecipe(
      { ...initial, tools: { shellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" } },
      recipe.id
    ).bootstrapAgent.checks
  ).toEqual(recipe.powershell!.checks)
})

it("has translated labels and descriptions for every catalog entry", () => {
  for (const messages of [en, zh]) {
    const groups = [
      [BOOTSTRAP_PRESETS.providers, messages.bootstrap.presets.providerOptions],
      [BOOTSTRAP_PRESETS.presets, messages.bootstrap.presets.taskOptions],
      [BOOTSTRAP_PRESETS.recipes, messages.bootstrap.presets.recipeOptions],
    ] as const
    for (const [entries, translations] of groups) {
      for (const entry of entries) {
        expect(translations).toHaveProperty(`${entry.id}.label`)
        expect(translations).toHaveProperty(`${entry.id}.description`)
      }
    }
  }
})

it("refuses unknown selections rather than applying a partial configuration", () => {
  for (const apply of [applyBootstrapProvider, applyBootstrapTaskPreset, applyBootstrapRecipe]) {
    expect(() => apply(initial, "unknown")).toThrow()
  }
})
