import catalog from "@/scripts/bootstrap/presets.json"
import type {
  ProjectEnvironmentBootstrapAgent,
  ProjectEnvironmentBootstrapModelOptions,
  ProjectEnvironmentScript,
} from "@/types/project-environment"

type Agent = ProjectEnvironmentBootstrapAgent
type PresetConfig = {
  task?: string
  setupCommand?: string
  checks?: Agent["checks"]
  model?: ProjectEnvironmentBootstrapModelOptions & {
    baseUrl?: string
    model?: string
    apiKeyEnv?: string
  }
  tools?: Agent["tools"]
  context?: Agent["context"]
  reuse?: Agent["reuse"]
  limits?: Pick<
    Agent,
    | "maxSteps"
    | "totalTimeoutSecs"
    | "commandTimeoutSecs"
    | "maxOutputBytes"
    | "maxContextBytes"
    | "maxResponseBytes"
  >
}

// Shared with the single-file CLI catalogs; no network or runtime dependency.
export const BOOTSTRAP_PRESETS = catalog

function applyConfig(current: Agent, patch: PresetConfig): Agent {
  const { model, limits, setupCommand: _setupCommand, ...fields } = patch
  const { baseUrl, model: modelId, apiKeyEnv, ...options } = model ?? {}
  return {
    ...current,
    ...fields,
    ...limits,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(modelId !== undefined ? { model: modelId } : {}),
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    ...(model ? { modelOptions: { ...current.modelOptions, ...options } } : {}),
    ...(patch.tools ? { tools: { ...current.tools, ...patch.tools } } : {}),
    ...(patch.context ? { context: { ...current.context, ...patch.context } } : {}),
    ...(patch.reuse ? { reuse: { ...current.reuse, ...patch.reuse } } : {}),
    advancedOptionsDraft: undefined,
  }
}

export function applyBootstrapProvider(current: Agent, id: string): Agent {
  const provider = catalog.providers.find((entry) => entry.id === id)
  if (!provider) throw new Error("Unknown bootstrap provider")
  const { baseUrl, model, apiKeyEnv, ...options } = provider.config.model
  return {
    ...current,
    baseUrl,
    model,
    apiKeyEnv,
    // Never carry credentials, headers, endpoints or provider-specific body
    // options across a provider change, including an unfinished JSON draft.
    modelOptions: options as ProjectEnvironmentBootstrapModelOptions,
    advancedOptionsDraft: undefined,
  }
}

export function applyBootstrapTaskPreset(current: Agent, id: string): Agent {
  const preset = catalog.presets.find((entry) => entry.id === id)
  if (!preset) throw new Error("Unknown bootstrap task preset")
  return applyConfig(current, preset.config)
}

export function applyBootstrapRecipe(
  current: Agent,
  id: string
): { bootstrapAgent: Agent; setupScript: ProjectEnvironmentScript } {
  const recipe = catalog.recipes.find((entry) => entry.id === id)
  if (!recipe) throw new Error("Unknown bootstrap initialization recipe")
  const shell = current.tools?.shellExecutable
  const powershell = shell
    ? /(?:^|[/\\])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell)
    : current.runtime === "powershell"
  const shellPatch = powershell && "powershell" in recipe ? recipe.powershell : undefined
  const bootstrapAgent = applyConfig(applyConfig(current, recipe.config), shellPatch ?? {})
  const setupCommand =
    (shellPatch as PresetConfig | undefined)?.setupCommand ?? recipe.config.setupCommand
  // A recipe replaces every previous OS override. The Agent executes this
  // command using its selected shell on all hosts, rather than the host shell.
  return { bootstrapAgent, setupScript: { default: setupCommand, byOs: {} } }
}
