/** Current installation authority intersected with the immutable host run ceiling. */
import { getExecutionRun } from "@/lib/db/execution-runs"
import { getBotInstallation } from "@/lib/db/bot-installations"
import { getBotRunStep } from "@/lib/db/bot-run-steps"
import { requireOwnedBotRun } from "@/lib/bot/runtime/owned-run"
import { getBotEntry } from "@/lib/plugin/registries/bot-registry"
import type { PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"
import type { ExecutionRunInterrupt } from "@/types/execution/run"
import { resolveBotPolicy } from "./ceilings"

export const BOT_RUN_POLICY_STEP = "__host:policy"

/** Undefined caller is reserved for the host step runtime; plugin APIs always name their caller. */
export async function resolveOwnedBotAuthority(pluginId: string | undefined, runId: string) {
  if (!pluginId) {
    const run = await getExecutionRun(runId)
    const installation = run?.sourceId ? await getBotInstallation(run.sourceId) : undefined
    pluginId = installation ? getBotEntry(installation.definitionId)?.pluginId : undefined
    if (!pluginId) throw new Error("Bot policy authority has no registered owning plugin")
  }
  const owned = await requireOwnedBotRun(pluginId, runId)
  if (owned.resolved.problems.length) throw new Error("Bot definition is unavailable or changed")
  const checkpoint = await getBotRunStep(runId, BOT_RUN_POLICY_STEP)
  if (
    checkpoint?.status !== "completed" ||
    !checkpoint.output ||
    typeof checkpoint.output !== "object" ||
    Array.isArray(checkpoint.output)
  )
    throw new Error("Bot run has no host policy checkpoint; start a new run")
  const grant = owned.installation.policyGrant ?? {}
  const effectivePolicy = resolveBotPolicy([
    { name: "organization", policy: checkpoint.output as PluginBotPolicyV1 },
    { name: "installation", policy: owned.resolved.policy },
  ]).policy
  return {
    ...owned,
    grant,
    effectivePolicy,
    automatedPublicationAllowed:
      grant.requireApprovalForWrites === false &&
      grant.maxAutonomy === "autopilot" &&
      effectivePolicy.requireApprovalForWrites === false &&
      effectivePolicy.maxAutonomy === "autopilot" &&
      effectivePolicy.maxAuthority !== "plan",
  }
}

/** Human decisions remain human; policy decisions lose authority immediately when the grant narrows. */
export async function assertBotPublicationAuthority(
  pluginId: string,
  runId: string,
  approval: ExecutionRunInterrupt
) {
  if (approval.approvalDecisionMode !== "policy") return
  const authority = await resolveOwnedBotAuthority(pluginId, runId)
  if (
    approval.approvalPolicy?.kind !== "bot-installation" ||
    approval.approvalPolicy.installationId !== authority.installation.id ||
    !authority.automatedPublicationAllowed
  )
    throw new Error("Bot automatic publication is no longer authorized by host policy")
}
