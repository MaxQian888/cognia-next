/** Host-only resolution of a Bot's explicitly installed integration binding. */
import { getDb } from "@/lib/db/schema"
import { getBotRunStep } from "@/lib/db/bot-run-steps"
import { requireOwnedBotRun } from "@/lib/bot/runtime/owned-run"
import { assertBotPublicationAuthority } from "@/lib/bot/policy/run-authority"
import { getBot } from "@/lib/plugin/registries/bot-registry"
import { getRegisteredIntegration } from "@/lib/integrations/registry"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { defaultsFromConfigSchema } from "@/lib/bot/config/resolve-effective"
import type { IntegrationBotBindingRef } from "@/types/plugin/plugin-integration"

export async function resolveBotIntegrationBinding(
  pluginId: string,
  ref: IntegrationBotBindingRef,
  expectedRepository?: string
) {
  if (
    !ref ||
    typeof ref.runId !== "string" ||
    !ref.runId ||
    typeof ref.slotId !== "string" ||
    !ref.slotId
  ) {
    throw new Error("Invalid Bot integration binding")
  }
  const { run, installation } = await requireOwnedBotRun(pluginId, ref.runId)
  const definition = getBot(installation.definitionId)?.definition
  if (!definition || definition.version !== installation.pinnedVersion) {
    throw new Error("Bot integration definition is unavailable or changed")
  }
  const slot = definition.requires?.credentials?.find((candidate) => candidate.id === ref.slotId)
  const accountId = installation.credentialBindings[ref.slotId]?.integrationAccountId
  const account = accountId ? await getDb().integrationAccounts.get(accountId) : undefined
  if (!slot?.integration || !account?.enabled) throw new Error("Bot credential slot is not bound")
  const integration = getRegisteredIntegration(account.pluginId, account.integrationId)?.definition
  if (!integration || ![account.pluginId, account.integrationId].includes(slot.integration)) {
    throw new Error("Bot credential slot integration does not match")
  }
  if (
    slot.strategy &&
    !integration.authStrategies.some(
      (strategy) => strategy.id === slot.strategy && strategy.providerId === account.providerId
    )
  ) {
    throw new Error("Bot credential slot auth strategy does not match")
  }
  const caller = usePluginStore.getState().plugins[pluginId]
  if (account.pluginId !== pluginId && !caller?.manifest.dependencies?.[account.pluginId]) {
    throw new Error("Bot integration provider dependency is not declared")
  }
  const config = { ...defaultsFromConfigSchema(definition.configSchema), ...installation.config }
  const configured = config.repository ?? config.repoFullName
  if (
    typeof configured !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configured) ||
    configured.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Bot integration repository scope is missing")
  }
  const repository = configured.toLowerCase()
  if (expectedRepository && expectedRepository.toLowerCase() !== repository) {
    throw new Error("Bot integration repository is outside its installation scope")
  }
  return { run, installation, definition, account, repository }
}

/** Exact JSON equality, independent of property insertion order. */
export function canonicalIntegrationValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalIntegrationValue).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalIntegrationValue((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export async function assertBotIntegrationAction(
  pluginId: string,
  ref: IntegrationBotBindingRef,
  action: { integrationId: string; actionId: string; input: Record<string, unknown> },
  approvalId?: string
) {
  const binding = await resolveBotIntegrationBinding(pluginId, ref)
  let approvedPublication: { headSha: string; branch: string } | undefined
  if (
    binding.account.integrationId !== action.integrationId ||
    !binding.definition.requires?.integrationActions?.includes(
      `${action.integrationId}.${action.actionId}`
    )
  ) {
    throw new Error("Bot integration action is not allowlisted")
  }
  if (
    typeof action.input.repoFullName !== "string" ||
    action.input.repoFullName.toLowerCase() !== binding.repository
  ) {
    throw new Error("Bot integration action repository is outside its installation scope")
  }
  const definition = getRegisteredIntegration(
    binding.account.pluginId,
    action.integrationId
  )?.definition.actions.find((candidate) => candidate.id === action.actionId)
  if (!definition) throw new Error("Bot integration action is unavailable")
  if (definition.risk !== "read") {
    const approval = approvalId ? await getDb().executionRunInterrupts.get(approvalId) : undefined
    if (
      !approval ||
      approval.runId !== ref.runId ||
      approval.type !== "bot_approval" ||
      approval.status !== "approved" ||
      approval.expiresAt <= Date.now()
    ) {
      throw new Error("Bot integration write requires an unexpired approval")
    }
    const detail = (approval as typeof approval & { approvalDetail?: Record<string, unknown> })
      .approvalDetail
    await assertBotPublicationAuthority(pluginId, ref.runId, approval)
    const approved = Array.isArray(detail?.approvedActions)
      ? detail.approvedActions
      : [detail?.approvedAction]
    const target = canonicalIntegrationValue({ actionId: action.actionId, input: action.input })
    if (!approved.some((candidate) => canonicalIntegrationValue(candidate) === target)) {
      throw new Error("Bot integration write does not match the approved action")
    }
    if (binding.account.pluginId === "github-delivery" && action.actionId === "openPr") {
      const snapshot = detail?.snapshot as { id?: string } | undefined
      const publish = detail?.publish as { branch?: string } | undefined
      if (
        !snapshot?.id ||
        typeof snapshot.id !== "string" ||
        publish?.branch !== action.input.head
      ) {
        throw new Error("Bot pull request requires its approved publication snapshot")
      }
      const [snapshotStep, publicationStep] = await Promise.all([
        getBotRunStep(ref.runId, `__host:snapshot:${snapshot.id}`),
        getBotRunStep(ref.runId, `__host:publication:${snapshot.id}`),
      ])
      const publication = publicationStep?.output as Record<string, unknown> | undefined
      if (
        snapshotStep?.status !== "completed" ||
        canonicalIntegrationValue(snapshotStep.output) !==
          canonicalIntegrationValue(detail?.snapshot) ||
        publicationStep?.status !== "completed" ||
        publication?.snapshotId !== snapshot.id ||
        publication.repository !== binding.repository ||
        publication.branch !== action.input.head ||
        typeof publication.headSha !== "string" ||
        !/^[a-fA-F0-9]{40}$/.test(publication.headSha)
      ) {
        throw new Error("Bot pull request publication does not match its approved snapshot")
      }
      approvedPublication = { headSha: publication.headSha, branch: publication.branch as string }
    }
  }
  return { ...binding, approvedPublication }
}
