/** Authenticated host lifecycle boundary; definitions and credentials are resolved locally. */
import { canonicalIntegrationValue } from "@/lib/plugin/api/bot-integration-binding"
import { BOT_WRITE_COMMANDS, resolveBotWriteRoute } from "./route"
import { z } from "zod"
import { buildBotRows, countDeadLettersByInstallation } from "@/lib/bot/console/bot-rows"
import { buildCredentialCandidates } from "@/lib/bot/console/credential-candidates"
import { listBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { listAllIntegrationAccounts } from "@/lib/db/integrations"
import { listAdapterInstances } from "@/lib/db/adapter-instances"
import { buildBotCatalog } from "@/lib/bot/console/catalog"
import { defaultsFromConfigSchema } from "@/lib/bot/config/resolve-effective"
import { listBotDefinitions } from "@/lib/db/bot-definitions"
import { getBotInstallation, listBotInstallations } from "@/lib/db/bot-installations"
import { getDb } from "@/lib/db/schema"
import { resolveInstalledBot } from "@/lib/bot/installed-bot"
import { listBotEntries } from "@/lib/plugin/registries/bot-registry"
import { getRegisteredIntegration } from "@/lib/integrations/registry"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import { projectBotInstallationRow } from "@/lib/sync/desktop-sync-source"
import type { PluginBotCredentialSlot } from "@/types/plugin/plugin-bot"
import {
  installBotFromCatalogLocally,
  updateBotConfigLocally,
  bindBotCredentialLocally,
  setBotInstallationEnabledLocally,
  uninstallBotInstallationLocally,
  botPolicyGrantSchema,
} from "./lifecycle"

const id = z.string().min(1).max(256)
const common = { operationId: z.string().uuid() }
const binding = z.union([
  z.object({ integrationAccountId: id }).strict(),
  z.object({ adapterId: id }).strict(),
])
const config = z.record(z.string(), z.unknown())
export const botLifecycleMutationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...common,
      operation: z.literal("install"),
      definitionId: id,
      version: id,
      scope: z
        .object({
          kind: z.enum(["account", "workspace", "project"]),
          workspaceId: id.optional(),
          projectId: id.optional(),
        })
        .strict(),
      config: config.optional(),
      credentialBindings: z.record(z.string(), binding).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      operation: z.literal("config"),
      installationId: id,
      config,
      policyGrant: botPolicyGrantSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      operation: z.literal("bind"),
      installationId: id,
      slotId: id,
      binding: binding.nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      operation: z.literal("set_enabled"),
      installationId: id,
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ ...common, operation: z.literal("uninstall"), installationId: id }).strict(),
])
export type BotLifecycleMutation = z.infer<typeof botLifecycleMutationSchema>

export async function readHostBotCatalog() {
  const [local, installations] = await Promise.all([listBotDefinitions(), listBotInstallations()])
  return buildBotCatalog({ registry: listBotEntries(), local, installations })
}

function validateConfig(
  schema: Record<string, unknown> | undefined,
  value: Record<string, unknown>
) {
  const effective = { ...defaultsFromConfigSchema(schema), ...value }
  if (schema) {
    const result = validateAgainstJsonSchema(schema, effective)
    if (!result.ok) throw new Error(`Invalid Bot configuration: ${result.errors.join("; ")}`)
  }
  return effective
}

async function validateBinding(
  slot: PluginBotCredentialSlot | undefined,
  value: z.infer<typeof binding> | null
) {
  if (!slot) throw new Error("Bot credential slot is not declared")
  if (!value) return
  if ("integrationAccountId" in value) {
    const account = await getDb().integrationAccounts.get(value.integrationAccountId)
    if (
      !account ||
      (slot.integration && ![account.pluginId, account.integrationId].includes(slot.integration))
    )
      throw new Error("Bot credential account does not match its slot")
    const integration = getRegisteredIntegration(
      account.pluginId,
      account.integrationId
    )?.definition
    if (
      !integration ||
      (slot.strategy &&
        !integration.authStrategies.some(
          (strategy) => strategy.id === slot.strategy && strategy.providerId === account.providerId
        ))
    )
      throw new Error("Bot credential strategy does not match its slot")
  } else {
    const adapter = await getDb().adapterInstances.get(value.adapterId)
    if (!adapter || (slot.integration && adapter.type !== slot.integration))
      throw new Error("Bot credential adapter does not match its slot")
  }
}

export async function mutateBotInstallationOnHost(raw: unknown) {
  if (resolveBotWriteRoute(BOT_WRITE_COMMANDS.mutateInstallation) !== "local")
    throw new Error("Bot lifecycle mutation must execute on its owning host")
  const input = botLifecycleMutationSchema.parse(raw)
  if (input.operation === "install") {
    const entry = (await readHostBotCatalog()).find(
      (item) => item.definitionId === input.definitionId
    )
    if (!entry || entry.version !== input.version)
      throw new Error("Bot catalog definition is missing or changed")
    if (
      (input.scope.kind === "workspace" && !input.scope.workspaceId) ||
      (input.scope.kind === "project" && !input.scope.projectId)
    )
      throw new Error("Bot installation scope is incomplete")
    const scopedId = input.scope.workspaceId ?? input.scope.projectId
    if (scopedId && !(await getDb().projects.get(scopedId)))
      throw new Error("Bot installation scope does not exist on this host")
    const config = validateConfig(entry.configSchema, input.config ?? {})
    for (const [slotId, value] of Object.entries(input.credentialBindings ?? {}))
      await validateBinding(
        entry.slots.find((slot) => slot.id === slotId),
        value
      )
    const installationId = `boti_${input.operationId}`
    const existing = await getBotInstallation(installationId)
    if (existing) {
      if (
        existing.definitionId !== entry.definitionId ||
        existing.pinnedVersion !== entry.version ||
        canonicalIntegrationValue(existing.config) !== canonicalIntegrationValue(config) ||
        canonicalIntegrationValue(existing.scope) !== canonicalIntegrationValue(input.scope) ||
        canonicalIntegrationValue(existing.credentialBindings) !==
          canonicalIntegrationValue(input.credentialBindings ?? {})
      )
        throw new Error("Bot installation operation already belongs to another definition")
      return projectBotInstallationRow(existing)
    }
    const row = await installBotFromCatalogLocally(
      { entry, scope: input.scope, config, credentialBindings: input.credentialBindings },
      installationId
    )
    return projectBotInstallationRow(row)
  }
  const installation = await getBotInstallation(input.installationId)
  if (!installation && input.operation === "uninstall")
    return { id: input.installationId, removed: true }
  if (!installation || installation.syncedFromHost)
    throw new Error("Bot installation is not owned by this host")
  if (input.operation === "uninstall") {
    await uninstallBotInstallationLocally(input.installationId)
    return projectBotInstallationRow(installation)
  }
  const resolved = await resolveInstalledBot(installation)
  if (!resolved) throw new Error("Bot installation definition is missing")
  if (input.operation === "config") {
    const config = validateConfig(resolved.definition.configSchema, input.config)
    return projectBotInstallationRow(
      await updateBotConfigLocally(input.installationId, config, input.policyGrant)
    )
  }
  if (input.operation === "bind") {
    await validateBinding(
      resolved.definition.requires?.credentials?.find((slot) => slot.id === input.slotId),
      input.binding
    )
    return projectBotInstallationRow(
      await bindBotCredentialLocally(input.installationId, input.slotId, input.binding)
    )
  }
  return projectBotInstallationRow(
    await setBotInstallationEnabledLocally(input.installationId, input.enabled)
  )
}

/** Live administrative read. It deliberately never returns account auth-session handles. */
export async function readBotConsoleOnHost(raw: unknown) {
  const { view } = z
    .object({ view: z.enum(["catalog", "installations", "credentials"]) })
    .strict()
    .parse(raw)
  if (view === "catalog") return { entries: await readHostBotCatalog() }
  if (view === "credentials") {
    const [catalog, accounts, adapters] = await Promise.all([
      readHostBotCatalog(),
      listAllIntegrationAccounts(),
      listAdapterInstances(),
    ])
    const integrations = new Set([
      "",
      ...catalog.flatMap((entry) => entry.slots.map((slot) => slot.integration ?? "")),
    ])
    return {
      groups: Object.fromEntries(
        [...integrations].map((integration) => [
          integration,
          buildCredentialCandidates({
            slot: { id: "picker", integration: integration || undefined },
            accounts,
            adapters,
          }),
        ])
      ),
    }
  }
  const [installations, deadLetters] = await Promise.all([
    listBotInstallations(),
    listBotDeliveries({ status: "deadletter", limit: 500 }),
  ])
  const counts = countDeadLettersByInstallation(deadLetters)
  const owned = installations.filter((row) => !row.syncedFromHost)
  const rows = buildBotRows(
    await Promise.all(
      owned.map(async (installation) => ({
        installation,
        resolved: await resolveInstalledBot(installation),
        deadLetters: counts[installation.id] ?? 0,
      }))
    )
  )
  // buildBotRows includes only integration/adapter IDs; function handlers and authSessionId stay host-side.
  return { rows }
}
