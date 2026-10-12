import { isValidTrigger, parseRepository } from "@cognia/github-bot-kit"

/**
 * Installation configuration. Everything that decides who may command the Bot
 * or where it answers is the installation's, never a default that could point
 * at somebody else: no default repository, no default allowlist, and no
 * default trigger for a personal-token account (its login is a person's).
 */
export const REPOSITORY_REQUIRED_MESSAGE =
  "Set the repository (owner/repo) in this Bot installation's configuration before running it."
export const TRIGGER_REQUIRED_MESSAGE =
  "Set the trigger mention: this account is not a GitHub App, so its login is a person's and cannot be the default."
export const ALLOWLIST_REQUIRED_MESSAGE =
  "Add at least one GitHub user id to allowedAuthorIds; nobody can command the Bot until you do."

/**
 * A configuration the Bot cannot run with. The code is stable and shown in
 * the installation's monitor; the run ends as `needs_setup` instead of
 * failing and being retried.
 */
export class SetupError extends Error {
  constructor(
    readonly code:
      "repository_missing" | "allowlist_empty" | "trigger_required" | "trigger_conflict",
    message: string
  ) {
    super(message)
    this.name = "SetupError"
  }
}

const PRESET = /^[a-z0-9][a-z0-9-]{0,63}$/
const USER_ID = /^[1-9][0-9]{0,19}$/

export interface Config {
  repository: string
  /** Explicit trigger, or undefined to use the App's own `@<slug>`. */
  trigger?: string
  allowedAuthorIds: string[]
  publicationMode: "automatic" | "approval"
  agentPreset: string
  /** Only for the agent's own login; a Cognia model route names its own model. */
  model?: string
  timeoutMs: number
  commandMaxAgeMs: number
  pollIntervalMs: number
}

function integerIn(raw: unknown, fallback: number, min: number, max: number, name: string): number {
  const value = raw ?? fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

export function parseConfig(raw: Record<string, unknown>): Config {
  if (raw.repository === undefined || raw.repository === null || raw.repository === "")
    throw new SetupError("repository_missing", REPOSITORY_REQUIRED_MESSAGE)
  const repository = parseRepository(raw.repository, REPOSITORY_REQUIRED_MESSAGE)
  let trigger: string | undefined
  if (raw.trigger !== undefined && raw.trigger !== null && raw.trigger !== "") {
    if (typeof raw.trigger !== "string" || !isValidTrigger(raw.trigger.trim()))
      throw new Error("trigger must be a GitHub mention such as @my-bot")
    trigger = raw.trigger.trim()
  }
  const ids = raw.allowedAuthorIds ?? []
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !USER_ID.test(id)))
    throw new Error("allowedAuthorIds must be a list of numeric GitHub user ids")
  if (!ids.length) throw new SetupError("allowlist_empty", ALLOWLIST_REQUIRED_MESSAGE)
  const publicationMode = raw.publicationMode ?? "automatic"
  if (publicationMode !== "automatic" && publicationMode !== "approval")
    throw new Error("publicationMode must be automatic or approval")
  const agentPreset = raw.agentPreset ?? "claude-code"
  if (typeof agentPreset !== "string" || !PRESET.test(agentPreset))
    throw new Error("agentPreset must be an external agent preset id")
  let model: string | undefined
  if (raw.model !== undefined && raw.model !== null && raw.model !== "") {
    if (typeof raw.model !== "string" || !raw.model.trim() || raw.model.length > 200)
      throw new Error("model must be a model id")
    model = raw.model.trim()
  }
  return {
    repository,
    trigger,
    allowedAuthorIds: [...new Set(ids as string[])],
    publicationMode,
    agentPreset,
    model,
    timeoutMs: integerIn(raw.timeoutMinutes, 15, 1, 30, "timeoutMinutes") * 60_000,
    commandMaxAgeMs:
      integerIn(raw.commandMaxAgeHours, 24, 1, 168, "commandMaxAgeHours") * 3_600_000,
    pollIntervalMs: integerIn(raw.pollIntervalMs, 60_000, 30_000, 3_600_000, "pollIntervalMs"),
  }
}

export const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "allowedAuthorIds"],
  properties: {
    repository: {
      type: "string",
      title: "Repository",
      description: "The repository whose comments this Bot answers, as owner/repo.",
      pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
    },
    trigger: {
      type: "string",
      title: "Trigger mention",
      description:
        "The mention that addresses the Bot, for example @my-bot. Leave empty on a GitHub App account to use the App's own name; a personal-token account must set it.",
      pattern: "^@[A-Za-z0-9][A-Za-z0-9-]{0,38}$",
    },
    allowedAuthorIds: {
      type: "array",
      title: "Allowed authors (GitHub user ids)",
      description:
        "Numeric GitHub user ids that may command the Bot. Each must also have write access to the repository when the command is checked.",
      items: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
      minItems: 1,
    },
    publicationMode: {
      type: "string",
      title: "Publication mode",
      enum: ["automatic", "approval"],
      default: "automatic",
      description:
        "Automatic publishes answers under an explicit host policy grant; approval asks a person before every reply.",
    },
    agentPreset: {
      type: "string",
      title: "External agent",
      default: "claude-code",
      description:
        "The external agent preset that answers. Its model lane is the installation's route.",
    },
    model: {
      type: "string",
      title: "Agent model",
      description:
        "Only for an agent on its own login. Leave empty when the installation routes through a Cognia model.",
    },
    timeoutMinutes: {
      type: "integer",
      title: "Answer timeout (minutes)",
      minimum: 1,
      maximum: 30,
      default: 15,
    },
    commandMaxAgeHours: {
      type: "integer",
      title: "Command validity (hours)",
      description: "A command older than this is not executed.",
      minimum: 1,
      maximum: 168,
      default: 24,
    },
    pollIntervalMs: {
      type: "integer",
      title: "Polling interval (ms)",
      description: "How often comments are polled when webhooks are not delivering.",
      minimum: 30_000,
      maximum: 3_600_000,
      default: 60_000,
    },
  },
}
