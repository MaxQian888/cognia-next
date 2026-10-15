import { shellQuote, tokenizeShellCommand } from "@/lib/mcp/config-transfer"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import { effectiveStateIsolation } from "@/components/agent/external-agent/add-agent/state-isolation-field"
import type {
  UpdateExternalAgentInput,
  ExternalAgentStateIsolation,
} from "@/types/agent/external-agent"

export interface ConnectionDraft {
  name: string
  description: string
  stateIsolation: ExternalAgentStateIsolation
  /** As typed; empty means unlimited. */
  sessionLimit: string
  sessionIdleTimeout: string
  processCommand: string
  processArgs: string
  processCwd: string
  networkEndpoint: string
  networkApiKey: string
  timeoutMs: string
  retryMaxRetries: string
  retryDelayMs: string
  retryMaxDelayMs: string
  retryExponentialBackoff: boolean
}

export function draftFromAgent(agent: LifecycleExternalAgentConfig): ConnectionDraft {
  return {
    name: agent.name,
    description: agent.description ?? "",
    stateIsolation: agent.stateIsolation ?? "shared",
    sessionLimit: agent.maxConcurrentSessions ? String(agent.maxConcurrentSessions) : "",
    sessionIdleTimeout: agent.sessionIdleTimeout ? String(agent.sessionIdleTimeout) : "",
    processCommand: agent.process?.command ?? "",
    processArgs: Array.isArray(agent.process?.args)
      ? agent.process.args.map(shellQuote).join(" ")
      : "",
    processCwd: agent.process?.cwd ?? "",
    networkEndpoint: agent.network?.endpoint ?? "",
    networkApiKey: agent.network?.apiKey ?? "",
    timeoutMs: String(agent.timeout ?? 300000),
    retryMaxRetries: String(agent.retryConfig?.maxRetries ?? 3),
    retryDelayMs: String(agent.retryConfig?.retryDelay ?? 1000),
    retryMaxDelayMs: String(agent.retryConfig?.maxRetryDelay ?? 30000),
    retryExponentialBackoff: agent.retryConfig?.exponentialBackoff ?? true,
  }
}

export function countDirtyFields(draft: ConnectionDraft, base: ConnectionDraft): number {
  return (Object.keys(draft) as (keyof ConnectionDraft)[]).filter((key) => draft[key] !== base[key])
    .length
}

/** Untouched fields follow the store; edits survive intervening instant writes. */
export function rebaseDraft(
  draft: ConnectionDraft,
  oldBase: ConnectionDraft,
  newBase: ConnectionDraft
): ConnectionDraft {
  const merged = { ...newBase }
  const keepEdited = <K extends keyof ConnectionDraft>(key: K) => {
    if (draft[key] !== oldBase[key]) merged[key] = draft[key]
  }
  for (const key of Object.keys(draft) as (keyof ConnectionDraft)[]) keepEdited(key)
  return merged
}

export type DraftValidationKey =
  | "nameRequired"
  | "commandRequired"
  | "argumentsInvalid"
  | "endpointRequired"
  | "sessionLimitInvalid"
  | "invalidIdleTimeout"
  | "mobileDetailNonNegativeIntegerInvalid"

export type DraftErrors = Partial<Record<keyof ConnectionDraft, DraftValidationKey>>

/** Validate only the edited item, and preserve unrelated saved configuration. */
export function buildDraftUpdate(
  agent: LifecycleExternalAgentConfig,
  draft: ConnectionDraft,
  base: ConnectionDraft,
  fields?: readonly (keyof ConnectionDraft)[]
): { updates: UpdateExternalAgentInput; errors: DraftErrors } {
  if (fields) {
    const current = { ...base }
    const select = <K extends keyof ConnectionDraft>(key: K) => {
      current[key] = draft[key]
    }
    fields.forEach(select)
    draft = current
  }
  const updates: UpdateExternalAgentInput = {}
  const errors: DraftErrors = {}
  const changed = (key: keyof ConnectionDraft) =>
    (!fields || fields.includes(key)) && draft[key] !== base[key]
  const validate = (key: keyof ConnectionDraft) => (fields ? fields.includes(key) : changed(key))
  const integer = (value: string, minimum: number) => {
    const number = Number(value)
    return value.trim() !== "" && Number.isSafeInteger(number) && number >= minimum
      ? number
      : undefined
  }
  if (validate("name") && !draft.name.trim()) errors.name = "nameRequired"
  if (changed("name")) updates.name = draft.name.trim()
  if (changed("description")) updates.description = draft.description.trim()
  if (changed("stateIsolation")) {
    updates.stateIsolation = effectiveStateIsolation(
      draft.stateIsolation,
      draft.processCommand,
      tokenizeShellCommand(draft.processArgs) ?? []
    )
  }
  for (const [key, target, message] of [
    ["sessionLimit", "maxConcurrentSessions", "sessionLimitInvalid"],
    ["sessionIdleTimeout", "sessionIdleTimeout", "invalidIdleTimeout"],
  ] as const) {
    if (!validate(key)) continue
    const value = draft[key].trim() ? integer(draft[key], 1) : null
    if (value === undefined) errors[key] = message
    else if (changed(key)) updates[target] = value
  }
  const processKeys = ["processCommand", "processArgs", "processCwd"] as const
  if (processKeys.some(validate)) {
    if (agent.transport === "stdio" && !draft.processCommand.trim()) {
      errors.processCommand = "commandRequired"
    }
    const args = tokenizeShellCommand(draft.processArgs)
    if (args === null) errors.processArgs = "argumentsInvalid"
    if (processKeys.some(changed) && args !== null) {
      updates.process = {
        ...agent.process,
        command: draft.processCommand.trim(),
        args,
        cwd: draft.processCwd || undefined,
      }
    }
  }
  if (validate("networkEndpoint") || validate("networkApiKey")) {
    if (agent.transport !== "stdio" && !draft.networkEndpoint.trim()) {
      errors.networkEndpoint = "endpointRequired"
    }
    if (changed("networkEndpoint") || changed("networkApiKey")) {
      updates.network = {
        ...agent.network,
        endpoint: draft.networkEndpoint.trim(),
        apiKey: draft.networkApiKey || undefined,
      }
    }
  }
  const numberKeys = ["timeoutMs", "retryMaxRetries", "retryDelayMs", "retryMaxDelayMs"] as const
  for (const key of numberKeys) {
    if (validate(key) && integer(draft[key], 0) === undefined) {
      errors[key] = "mobileDetailNonNegativeIntegerInvalid"
    }
  }
  if (changed("timeoutMs") && !errors.timeoutMs) updates.timeout = Number(draft.timeoutMs)
  if ([...numberKeys.slice(1), "retryExponentialBackoff" as const].some(changed)) {
    updates.retryConfig = {
      ...agent.retryConfig,
      maxRetries: Number(draft.retryMaxRetries),
      retryDelay: Number(draft.retryDelayMs),
      maxRetryDelay: Number(draft.retryMaxDelayMs),
      exponentialBackoff: draft.retryExponentialBackoff,
    }
  }
  return { updates, errors }
}
