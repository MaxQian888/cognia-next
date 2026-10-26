/** Shared data contract for hosted Pi child-model routing; contains no filesystem or host imports. */
export const PI_SUBAGENT_MODELS_ENV = "COGNIA_TOOLHOST_PI_SUBAGENT_MODELS"
export const PI_GUARD_EXTENSION_ENV = "COGNIA_TOOLHOST_PI_GUARD_EXTENSION"

export interface PiSubagentRouting {
  family: "nico" | "gotgenes"
  packageDir: string
  agents: Record<string, string | null>
  sources: Record<string, string>
  defaultModel: string
  allowedModels: string[]
  providerId: string
  cwd?: string
}

export function decodePiSubagentRouting(raw: string | undefined): PiSubagentRouting | undefined {
  if (raw === undefined) return undefined
  const value = JSON.parse(raw) as PiSubagentRouting
  if (
    !value ||
    !["nico", "gotgenes"].includes(value.family) ||
    typeof value.packageDir !== "string" ||
    !value.agents ||
    typeof value.agents !== "object" ||
    !value.sources ||
    typeof value.sources !== "object" ||
    !Array.isArray(value.allowedModels) ||
    !value.allowedModels.every(
      (model) => typeof model === "string" && model.startsWith("cognia/")
    ) ||
    !value.allowedModels.includes(value.defaultModel) ||
    typeof value.providerId !== "string"
  )
    throw new Error("Invalid Pi subagent model routing")
  for (const model of Object.values(value.agents))
    if (model !== null && model !== "inherit" && !value.allowedModels.includes(model))
      throw new Error("Pi agent model is outside the task model plan")
  return value
}

/** Stage edits first: an invalid parallel/chain entry must not partially rewrite the call. */
export function routePiSubagentCall(
  input: Record<string, unknown>,
  routing: PiSubagentRouting,
  parentModel?: string
): void {
  if (input.action !== undefined || input.workflow !== undefined)
    throw new Error(
      "Managed Pi subagent models do not support management or scheduled launch calls"
    )
  const updates: Array<[Record<string, unknown>, string]> = []
  const visit = (entry: Record<string, unknown>) => {
    if (entry.workflow !== undefined || entry.action !== undefined)
      throw new Error("Unsupported managed Pi subagent launch form")
    const before = updates.length
    if (entry.cwd !== undefined && entry.cwd !== routing.cwd)
      throw new Error("Start a new Pi task before changing the subagent workspace")
    if (entry.agentScope !== undefined && entry.agentScope !== "both")
      throw new Error("Managed Pi subagent models require the admitted agent scope")
    const name = routing.family === "gotgenes" ? entry.subagent_type : entry.agent
    if (typeof name === "string") {
      const match = Object.hasOwn(routing.agents, name)
        ? name
        : Object.keys(routing.agents).find((agent) =>
            routing.family === "gotgenes"
              ? agent.toLowerCase() === name.toLowerCase()
              : agent === name
          )
      if (
        match === undefined &&
        !(
          routing.family === "gotgenes" &&
          ["general-purpose", "explore", "plan"].includes(name.toLowerCase())
        )
      )
        throw new Error("Pi subagent is outside the admitted task snapshot; start a new task")
      const explicit = match === undefined ? undefined : routing.agents[match]
      const requestedModel = explicit ?? entry.model ?? routing.defaultModel
      const inheritedModel = requestedModel === "inherit" ? parentModel : requestedModel
      if (typeof inheritedModel !== "string") throw new Error("Invalid Pi subagent call model")
      const model = inheritedModel.startsWith(`${routing.providerId}/`)
        ? `cognia/${inheritedModel.slice(routing.providerId.length + 1)}`
        : inheritedModel
      if (!routing.allowedModels.includes(model))
        throw new Error("Pi subagent call model is not admitted by this Cognia task")
      updates.push([entry, model])
    }
    for (const key of ["tasks", "chain", "parallel"]) {
      const children = entry[key]
      if (children !== undefined && !Array.isArray(children))
        throw new Error("Unsupported managed Pi subagent launch form")
      if (Array.isArray(children))
        for (const child of children) {
          if (!child || typeof child !== "object" || Array.isArray(child))
            throw new Error("Invalid Pi subagent task")
          visit(child as Record<string, unknown>)
        }
    }
    if (updates.length === before) throw new Error("Unsupported managed Pi subagent launch form")
  }
  visit(input)
  if (!updates.length) throw new Error("Unsupported managed Pi subagent launch form")
  for (const [entry, model] of updates) entry.model = model
}

/** Child SDK loaders must read the same installed executor and verified guard as their parent. */
export function withPiSubagentExtensions(
  input: Record<string, string> | undefined,
  extensions: readonly string[],
  guard: string
): Record<string, string> {
  const env = input ?? {}
  if (!env[PI_SUBAGENT_MODELS_ENV]) return env
  decodePiSubagentRouting(env[PI_SUBAGENT_MODELS_ENV])
  const payload = JSON.parse(env.COGNIA_GATEWAY_TASK_CONFIG)
  if (payload.runtime !== "pi") throw new Error("Pi subagent routing requires a Pi gateway task")
  const settings = JSON.parse(payload.files["pi/settings.json"])
  payload.files["pi/settings.json"] = JSON.stringify({
    ...settings,
    extensions: [...extensions, guard],
  })
  return {
    ...env,
    [PI_GUARD_EXTENSION_ENV]: guard,
    COGNIA_GATEWAY_TASK_CONFIG: JSON.stringify(payload),
  }
}
