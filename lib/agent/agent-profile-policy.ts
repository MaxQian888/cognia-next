import type {
  AgentEnvBinding,
  AgentExecutionPolicy,
  AgentModelRole,
  Character,
} from "@cognia/agent-config-types"

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidAgentEnvName(name: string): boolean {
  return ENV_NAME.test(name)
}

export type AgentSecretReader = (secretRef: string) => Promise<string | null>

export class AgentEnvironmentError extends Error {
  readonly code: "invalid_name" | "secret_missing" | "secret_unavailable"
  readonly variableName: string

  constructor(code: AgentEnvironmentError["code"], variableName: string, options?: ErrorOptions) {
    const detail =
      code === "invalid_name"
        ? "has an invalid environment variable name"
        : code === "secret_missing"
          ? "has no value in the secure keyring"
          : "could not be read from the secure keyring"
    super(`Agent environment variable ${variableName} ${detail}`, options)
    this.name = "AgentEnvironmentError"
    this.code = code
    this.variableName = variableName
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

/**
 * Resolve only the Agent-owned portion of the model chain. Higher-priority IM,
 * session, team-member, and mode overrides remain in `resolveSendOptions`.
 */
export function resolveAgentModel(
  role: AgentModelRole,
  agent: Character | null | undefined,
  appDefaultModel: string | undefined
): string | undefined {
  const semanticTarget = nonBlank(agent?.modelRouting?.[role])
  if (semanticTarget) return semanticTarget
  if (role === "execute") return nonBlank(agent?.model) ?? nonBlank(appDefaultModel)
  return nonBlank(appDefaultModel)
}

/** Merge bindings in stable order; a later source replaces an earlier name. */
export function mergeAgentEnvBindings(
  agentBindings: readonly AgentEnvBinding[] | undefined,
  sessionBindings: readonly AgentEnvBinding[] | undefined
): AgentEnvBinding[] {
  const merged = new Map<string, AgentEnvBinding>()
  for (const binding of agentBindings ?? []) merged.set(binding.name, { ...binding })
  for (const binding of sessionBindings ?? []) {
    // Reinsert replacements so session-owned values retain session ordering.
    merged.delete(binding.name)
    merged.set(binding.name, { ...binding })
  }
  return [...merged.values()]
}

function validateMaxTurns(maxTurns: number | undefined): void {
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)) {
    throw new RangeError("Agent execution policy maxTurns must be an integer between 1 and 100")
  }
}

export function resolveAgentExecutionPolicy(
  agentPolicy: AgentExecutionPolicy | null | undefined,
  sessionPolicy: AgentExecutionPolicy | null | undefined
): AgentExecutionPolicy {
  const maxTurns = sessionPolicy?.maxTurns ?? agentPolicy?.maxTurns
  validateMaxTurns(maxTurns)
  const envBindings = mergeAgentEnvBindings(agentPolicy?.envBindings, sessionPolicy?.envBindings)
  return {
    effort: sessionPolicy?.effort ?? agentPolicy?.effort,
    maxTurns,
    ...(envBindings.length > 0 ? { envBindings } : {}),
  }
}

/**
 * Materialize a policy immediately before dispatch. Secret values are returned
 * only in the ephemeral `SendOptions.env` map and never written back to the
 * Agent/session objects.
 */
export async function resolveAgentEnvironment(
  bindings: readonly AgentEnvBinding[] | undefined,
  readSecret: AgentSecretReader
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {}
  for (const binding of bindings ?? []) {
    if (!isValidAgentEnvName(binding.name)) {
      throw new AgentEnvironmentError("invalid_name", binding.name)
    }
    if (binding.kind === "plain") {
      resolved[binding.name] = binding.value
      continue
    }
    let value: string | null
    try {
      value = await readSecret(binding.secretRef)
    } catch (error) {
      throw new AgentEnvironmentError("secret_unavailable", binding.name, { cause: error })
    }
    if (!value) throw new AgentEnvironmentError("secret_missing", binding.name)
    resolved[binding.name] = value
  }
  return resolved
}
