/**
 * Whether this installation can actually answer commands, with stable codes.
 *
 * Blocking problems stop receiving (a run ends `needs_setup`); warnings are
 * reported and the Bot keeps working in a narrower shape. Cheap checks run
 * on every receive; the `check` trigger runs everything, including a real
 * checkout through the bound account.
 *
 * The host answers what only it knows (`getInstallation().readiness`): whether
 * a policy decision is automatic, and which model lane the agents run on.
 * Whether a person is reachable to approve is the host's own concern
 * (paired clients receive pending approvals); it is not guessed at here.
 */

import type { BotInstallationSnapshot, BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import type { GithubReader } from "@cognia/github-bot-kit"

import type { Config } from "./config"
import { SetupError } from "./config"
import { GITHUB_SLOT } from "./identity"

export type ReadinessCode =
  | "trigger_conflict"
  | "permission_probe_failed"
  | "private_clone_unavailable"
  | "pii_boundary_unverified"
  | "publication_grant_missing"
  | "executor_unavailable"
  | "no_ingress"

export interface ReadinessProblem {
  code: ReadinessCode
  blocking: boolean
  detail?: string
}

export type IngressMode = "webhook_ready" | "polling_only" | "no_ingress"

export interface ReadinessReport {
  ready: boolean
  ingress: IngressMode
  problems: ReadinessProblem[]
}

/** A claim older than this is a removed or idle installation's, and lapses. */
export const TRIGGER_CLAIM_TTL_MS = 60 * 60_000

interface TriggerClaim {
  installationId: string
  at: number
}

export const triggerClaimKey = (repository: string, trigger: string) =>
  `claim:v1:${repository.toLowerCase()}:${trigger.toLowerCase().replace(/\[bot\]$/, "")}`

/**
 * One installation per repository and trigger on this host. Two would both
 * answer every command; the Bot plane deduplicates per installation, not
 * across them. The live holder keeps refreshing its claim; a second
 * installation is refused until the first has been quiet for an hour.
 */
export async function claimTrigger(
  ctx: PluginContext,
  run: Pick<BotRunContextV1, "installationId">,
  repository: string,
  trigger: string,
  now: () => number = Date.now
): Promise<void> {
  const key = triggerClaimKey(repository, trigger)
  const claim = await ctx.storage.get<TriggerClaim>(key)
  if (
    claim &&
    claim.installationId !== run.installationId &&
    now() - claim.at < TRIGGER_CLAIM_TTL_MS
  )
    throw new SetupError(
      "trigger_conflict",
      `Another installation on this host already answers ${trigger} in ${repository}. Remove one, or give this one its own trigger.`
    )
  await ctx.storage.set(key, {
    installationId: run.installationId,
    at: now(),
  } satisfies TriggerClaim)
}

export function ingressMode(installation: BotInstallationSnapshot): IngressMode {
  if (
    installation.webhookEnabled &&
    installation.triggers.some((trigger) => trigger.id === "github" && trigger.armed)
  )
    return "webhook_ready"
  if (installation.triggers.some((trigger) => trigger.id === "poll" && trigger.armed))
    return "polling_only"
  return "no_ingress"
}

/** What the host's own answers mean for this Bot. */
export function hostWarnings(
  installation: BotInstallationSnapshot,
  config: Pick<Config, "publicationMode">
): ReadinessProblem[] {
  const problems: ReadinessProblem[] = []
  const readiness = installation.readiness
  if (config.publicationMode === "automatic" && readiness && !readiness.policyDecisions)
    problems.push({
      code: "publication_grant_missing",
      blocking: false,
      detail:
        "Automatic publication needs an autopilot grant without required write approval; until then every reply waits for a person.",
    })
  if (readiness?.executionRoute === "native")
    problems.push({
      code: "pii_boundary_unverified",
      blocking: false,
      detail:
        "The agent uses its own login, so model requests skip the gateway's per-request PII check; only the host's prompt redaction applies.",
    })
  if (readiness && !readiness.executionRoute)
    problems.push({
      code: "executor_unavailable",
      blocking: false,
      detail:
        "No model route is chosen; an agent that can use a Cognia model will not start until one is.",
    })
  return problems
}

export async function checkReadiness(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  reader: GithubReader,
  installation: BotInstallationSnapshot,
  options: { cloneProbe: boolean }
): Promise<ReadinessReport> {
  const problems: ReadinessProblem[] = []
  const ingress = ingressMode(installation)
  if (ingress === "no_ingress")
    problems.push({
      code: "no_ingress",
      blocking: true,
      detail: "Arm the GitHub comments trigger (with a webhook) or the poll trigger.",
    })
  let defaultBranchSha: string | undefined
  try {
    const repository = (await reader.request<{ default_branch?: string }>("")).data
    const health = await ctx.integrations.checkAccountHealth({
      runId: run.runId,
      slotId: GITHUB_SLOT,
    })
    if (health.health !== "healthy")
      problems.push({
        code: "permission_probe_failed",
        blocking: true,
        detail: health.message ?? health.code ?? `Account health is ${health.health}`,
      })
    if (repository.default_branch)
      defaultBranchSha = (
        await reader.request<{ sha?: string }>(
          `/commits/${encodeURIComponent(repository.default_branch)}`
        )
      ).data.sha
  } catch (error) {
    problems.push({
      code: "permission_probe_failed",
      blocking: true,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
  if (options.cloneProbe && defaultBranchSha) {
    try {
      await run.step.run("readiness-clone", () =>
        ctx.workspace.acquire({
          kind: "bot-run",
          runId: run.runId,
          repository: config.repository,
          ref: defaultBranchSha!,
          credentialSlot: GITHUB_SLOT,
        })
      )
    } catch (error) {
      problems.push({
        code: "private_clone_unavailable",
        blocking: true,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  problems.push(...hostWarnings(installation, config))
  return { ready: !problems.some((problem) => problem.blocking), ingress, problems }
}
