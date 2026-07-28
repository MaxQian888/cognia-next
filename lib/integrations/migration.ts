import type {
  IntegrationAccount,
  IntegrationAuditEntry,
  IntegrationMigrationPlan,
  IntegrationMigrationResult,
  IntegrationSubscription,
} from "@/types/plugin/plugin-integration"
import type { WorkflowNodeKind, WorkflowRow } from "@/types/workflow/visual"
import { getDb } from "@/lib/db/schema"

interface MigrationBackup {
  accounts: IntegrationAccount[]
  subscriptions: IntegrationSubscription[]
  workflows: WorkflowRow[]
  createdAccountIds: string[]
  createdSubscriptionIds: string[]
}

function migrationKind(migrationId: string, suffix: "backup" | "completed"): string {
  return `migration.${migrationId}.${suffix}`
}

function auditRow(
  pluginId: string,
  integrationId: string,
  kind: string,
  detail?: Record<string, unknown>
): IntegrationAuditEntry {
  return {
    id: crypto.randomUUID(),
    pluginId,
    integrationId,
    kind,
    outcome: "succeeded",
    detail,
    createdAt: new Date().toISOString(),
  }
}

function validatePlan(pluginId: string, plan: IntegrationMigrationPlan): void {
  if (!plan.id.trim() || !plan.integrationId.trim()) {
    throw new Error("Integration migration requires non-empty ids")
  }
  const accountIds = new Set<string>()
  for (const account of plan.accounts) {
    if (!account.id || accountIds.has(account.id)) {
      throw new Error(`Integration migration has duplicate account id "${account.id}"`)
    }
    if (account.integrationId !== plan.integrationId) {
      throw new Error(`Integration migration account "${account.id}" targets another integration`)
    }
    accountIds.add(account.id)
  }
  const subscriptionIds = new Set<string>()
  for (const subscription of plan.subscriptions) {
    if (!subscription.id || subscriptionIds.has(subscription.id)) {
      throw new Error(`Integration migration has duplicate subscription id "${subscription.id}"`)
    }
    if (
      subscription.integrationId !== plan.integrationId ||
      !accountIds.has(subscription.accountId)
    ) {
      throw new Error(
        `Integration migration subscription "${subscription.id}" has an invalid account`
      )
    }
    subscriptionIds.add(subscription.id)
  }
  for (const targetKind of Object.values(plan.workflowKindAliases)) {
    if (
      targetKind !== "trigger.integration.event" &&
      !targetKind.startsWith(`${pluginId}.action.`)
    ) {
      throw new Error(`Integration migration alias target "${targetKind}" is outside the plugin`)
    }
  }
}

export async function migrateLegacyIntegration(
  pluginId: string,
  plan: IntegrationMigrationPlan
): Promise<IntegrationMigrationResult> {
  validatePlan(pluginId, plan)
  const db = getDb()
  const completedKind = migrationKind(plan.id, "completed")
  const completed = await db.integrationAudit
    .where("pluginId")
    .equals(pluginId)
    .filter((entry) => entry.kind === completedKind)
    .first()
  if (completed) {
    return {
      migrationId: plan.id,
      migratedAccounts: plan.accounts.length,
      migratedSubscriptions: plan.subscriptions.length,
      migratedWorkflows: Number(completed.detail?.migratedWorkflows ?? 0),
      alreadyApplied: true,
    }
  }

  let migratedWorkflows = 0
  await db.transaction(
    "rw",
    [db.integrationAccounts, db.integrationSubscriptions, db.integrationAudit, db.workflows],
    async () => {
      const priorAccounts = await db.integrationAccounts
        .where("pluginId")
        .equals(pluginId)
        .toArray()
      const priorSubscriptions = await db.integrationSubscriptions
        .where("pluginId")
        .equals(pluginId)
        .toArray()
      const workflows = await db.workflows.toArray()
      const affected = workflows.filter((workflow) =>
        workflow.nodes.some((node) => plan.workflowKindAliases[node.type])
      )
      const backup: MigrationBackup = {
        accounts: priorAccounts,
        subscriptions: priorSubscriptions,
        workflows: affected,
        createdAccountIds: plan.accounts.map((account) => account.id),
        createdSubscriptionIds: plan.subscriptions.map((subscription) => subscription.id),
      }
      await db.integrationAudit.add(
        auditRow(pluginId, plan.integrationId, migrationKind(plan.id, "backup"), {
          backup,
        })
      )

      const now = new Date().toISOString()
      const accounts: IntegrationAccount[] = plan.accounts.map((account) => ({
        ...account,
        pluginId,
        enabled: account.enabled ?? true,
        health: "unknown",
        createdAt: now,
        updatedAt: now,
      }))
      const subscriptions: IntegrationSubscription[] = plan.subscriptions.map((subscription) => ({
        ...subscription,
        pluginId,
        eventTypes: [...new Set(subscription.eventTypes)].sort(),
        enabled: subscription.enabled ?? true,
        ingressRouteId: subscription.ingressSecretHandle ? crypto.randomUUID() : undefined,
        createdAt: now,
        updatedAt: now,
      }))
      await db.integrationAccounts.bulkPut(accounts)
      await db.integrationSubscriptions.bulkPut(subscriptions)

      for (const workflow of affected) {
        const nodes = workflow.nodes.map((node) => {
          const target = plan.workflowKindAliases[node.type]
          return target ? { ...node, type: target as WorkflowNodeKind } : node
        })
        await db.workflows.put({ ...workflow, nodes, updatedAt: Date.now() })
        migratedWorkflows += 1
      }
      if (
        (await db.integrationAccounts.bulkGet(accounts.map((account) => account.id))).filter(
          Boolean
        ).length !== accounts.length ||
        (
          await db.integrationSubscriptions.bulkGet(
            subscriptions.map((subscription) => subscription.id)
          )
        ).filter(Boolean).length !== subscriptions.length
      ) {
        throw new Error("Integration migration verification failed")
      }
      await db.integrationAudit.add(
        auditRow(pluginId, plan.integrationId, completedKind, {
          migratedAccounts: accounts.length,
          migratedSubscriptions: subscriptions.length,
          migratedWorkflows,
        })
      )
    }
  )
  return {
    migrationId: plan.id,
    migratedAccounts: plan.accounts.length,
    migratedSubscriptions: plan.subscriptions.length,
    migratedWorkflows,
    alreadyApplied: false,
  }
}

export async function rollbackIntegrationMigration(
  pluginId: string,
  migrationId: string
): Promise<void> {
  const db = getDb()
  const backupEntry = await db.integrationAudit
    .where("pluginId")
    .equals(pluginId)
    .filter((entry) => entry.kind === migrationKind(migrationId, "backup"))
    .last()
  const backup = backupEntry?.detail?.backup as MigrationBackup | undefined
  if (!backup) throw new Error(`Integration migration "${migrationId}" has no backup`)

  await db.transaction(
    "rw",
    [db.integrationAccounts, db.integrationSubscriptions, db.integrationAudit, db.workflows],
    async () => {
      await db.integrationSubscriptions.bulkDelete(backup.createdSubscriptionIds)
      await db.integrationAccounts.bulkDelete(backup.createdAccountIds)
      await db.integrationAccounts.bulkPut(backup.accounts)
      await db.integrationSubscriptions.bulkPut(backup.subscriptions)
      await db.workflows.bulkPut(backup.workflows)
      await db.integrationAudit
        .where("pluginId")
        .equals(pluginId)
        .filter(
          (entry) =>
            entry.kind === migrationKind(migrationId, "completed") ||
            entry.kind === migrationKind(migrationId, "backup")
        )
        .delete()
    }
  )
}
