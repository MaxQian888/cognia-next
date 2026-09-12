import type { PluginBotTriggerConditions } from "@/types/plugin/plugin-bot"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Provider fields are data. Missing values never satisfy an explicit condition. */
export function botConditionMismatch(
  conditions: PluginBotTriggerConditions | undefined,
  event: BotEventEnvelopeV1,
  config: Record<string, unknown> = {}
): string | undefined {
  if (!conditions) return undefined
  const payload = object(event.payload)
  const pr = object(payload.pull_request)
  const issue = object(payload.issue)
  const check = object(payload.check_run ?? payload.workflow_run)
  const repository = object(payload.repository).full_name ?? event.resource?.scope
  const branch = object(pr.base).ref ?? check.head_branch ?? payload.ref
  const labels = (pr.labels ?? issue.labels) as unknown
  const labelNames = Array.isArray(labels)
    ? labels.map((value) => (typeof value === "string" ? value : object(value).name))
    : []
  const matches = (expected: string[] | undefined, value: unknown) =>
    expected === undefined || (typeof value === "string" && expected.includes(value))
  if (!matches(conditions.repositories, repository)) return "repository"
  if (conditions.repositoryConfigKey) {
    const expected = config[conditions.repositoryConfigKey]
    if (typeof expected !== "string" || expected !== repository) return "repository"
  }
  if (!matches(conditions.branches, branch)) return "branch"
  if (conditions.labels && !conditions.labels.every((label) => labelNames.includes(label)))
    return "labels"
  if (!matches(conditions.actors, object(payload.sender).login ?? event.actor?.id)) return "actor"
  if (conditions.draft !== undefined && pr.draft !== conditions.draft) return "draft"
  if (!matches(conditions.conclusions, check.conclusion ?? payload.conclusion)) return "conclusion"
  return undefined
}
