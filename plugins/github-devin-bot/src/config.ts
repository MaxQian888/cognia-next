/** Configuration stays installation-owned; the plugin contains no repository credentials. */
export const DEFAULT_REPOSITORY = "NJUPT-SAST/sast-approval-next"
export const MODELS = ["swe-2-medium", "swe-2-high", "swe-2-max"] as const
export interface Config {
  repository: string
  model: (typeof MODELS)[number]
  timeoutMs: number
  maxRepairAttempts: number
}

export function parseConfig(raw: Record<string, unknown>): Config {
  const repository = raw.repository ?? DEFAULT_REPOSITORY
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must be owner/repo")
  }
  const model = raw.model ?? MODELS[0]
  if (!MODELS.includes(model as Config["model"])) throw new Error("Unsupported Devin SWE-2 model")
  const timeoutMinutes = raw.timeoutMinutes ?? 30
  const maxRepairAttempts = raw.maxRepairAttempts ?? 2
  if (
    typeof timeoutMinutes !== "number" ||
    !Number.isInteger(timeoutMinutes) ||
    timeoutMinutes < 1 ||
    timeoutMinutes > 30
  ) {
    throw new Error("timeoutMinutes must be an integer between 1 and 30")
  }
  if (
    typeof maxRepairAttempts !== "number" ||
    !Number.isInteger(maxRepairAttempts) ||
    maxRepairAttempts < 1 ||
    maxRepairAttempts > 2
  ) {
    throw new Error("maxRepairAttempts must be 1 or 2")
  }
  return {
    repository,
    model: model as Config["model"],
    timeoutMs: timeoutMinutes * 60_000,
    maxRepairAttempts,
  }
}

export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    repository: {
      type: "string",
      title: "Repository",
      default: DEFAULT_REPOSITORY,
      pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
    },
    model: { type: "string", title: "Devin model", enum: [...MODELS], default: MODELS[0] },
    timeoutMinutes: {
      type: "integer",
      title: "Execution timeout (minutes)",
      minimum: 1,
      maximum: 30,
      default: 30,
    },
    maxRepairAttempts: {
      type: "integer",
      title: "Maximum repair attempts",
      minimum: 1,
      maximum: 2,
      default: 2,
    },
  },
}
