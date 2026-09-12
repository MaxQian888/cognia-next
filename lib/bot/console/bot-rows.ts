/**
 * The `/bots` console's row model: pure functions over an installation and
 * whatever its definition resolved to.
 *
 * Kept out of the components for the same reason `lib/devices/build-device-rows.ts`
 * is: every question the console asks (is this armed, is it one binding away
 * from working, has anything dead-lettered) is a derivation over two rows, and
 * a derivation inside a component is one that cannot be tested without a DOM.
 *
 * The central shape decision is that an installation whose definition is GONE
 * still produces a row. `resolveInstalledBot` answers `null` there, and a
 * console that dropped those rows would leave a user with an installation they
 * can neither see nor uninstall, still holding scheduler tasks. It is surfaced
 * as {@link BotConsoleRow.orphaned} instead, which the row and the detail pane
 * both label inert.
 */

import { isBotTriggerArmed, unboundCredentialSlots } from "@/lib/db/bot-installations"
import type {
  BotDefinitionSource,
  BotEventDeliveryRow,
  BotInstallationRow,
  BotInstallationScope,
  BotInstallationStatus,
} from "@/lib/db/bot-types"
import type { BotResolutionProblem, InstalledBot } from "@/lib/bot/installed-bot"
import type { ResolvedBotPolicy } from "@/lib/bot/policy/ceilings"
import type {
  PluginBotCredentialSlot,
  PluginBotExecutor,
  PluginBotTriggerDef,
} from "@/types/plugin/plugin-bot"

export type BotTriggerKind = PluginBotTriggerDef["kind"]

/** One trigger as the console reads it: what it is, and whether it is armed. */
export interface BotTriggerSummary {
  id: string
  kind: BotTriggerKind
  armed: boolean
  label?: string
  labelKey?: string
  /**
   * The one detail that differs per kind AND is not translatable: a cron
   * expression, the event types, the platforms an interaction narrows to.
   * An interval is deliberately not folded in here, because "every 5 minutes"
   * is a translated sentence rather than a literal.
   */
  detail?: string
  /** Present for `poll` and `derivedState`. The caller formats it. */
  everyMs?: number
  inputSchema?: Record<string, unknown>
}

/**
 * One credential slot as the console reads it.
 *
 * The binding is an id, never a secret. Which of the three ids a slot needs is
 * the integration's business, so `bound` is true when it names ANY of them,
 * exactly as `unboundCredentialSlots` decides.
 */
export interface BotCredentialRow {
  id: string
  label: string
  optional: boolean
  bound: boolean
  /** Integration the account must belong to, when the slot names one. */
  integration?: string
  strategy?: string
  /** What it is bound TO, for a reader checking they picked the right account. */
  integrationAccountId?: string
  adapterId?: string
}

/** One installation, as the list and the detail pane both read it. */
export interface BotConsoleRow {
  /** The installation id. It is what `?bot=` carries and what writes address. */
  id: string
  definitionId: string
  source: BotDefinitionSource
  /**
   * The definition's name, or the definition id when nothing resolved. An
   * orphaned row has no name to show and the id is the only handle a user has
   * on it, so it stands in rather than leaving the row blank.
   */
  name: string
  description?: string
  /** Absent exactly when {@link orphaned} is true. */
  executor?: PluginBotExecutor
  status: BotInstallationStatus
  scope: BotInstallationScope
  /**
   * The definition could not be resolved at all: the plugin was disabled or
   * uninstalled, or a local definition row was deleted. The installation is
   * inert, not broken, and the console says so rather than rendering controls
   * that would act on nothing.
   */
  orphaned: boolean
  problems: readonly BotResolutionProblem[]
  triggers: readonly BotTriggerSummary[]
  armedTriggers: number
  /** Required slots this installation has not bound yet. */
  unboundSlots: readonly string[]
  requiredSlots: readonly PluginBotCredentialSlot[]
  /** Every declared slot, joined to what it is bound to. Empty for an orphan. */
  credentials: readonly BotCredentialRow[]
  /**
   * The intersected ceiling with its audit trail. Absent for an orphan: no
   * definition means no layers to fold, and an empty policy would read as "no
   * limits" rather than "nothing to limit".
   */
  policy?: ResolvedBotPolicy
  /**
   * The definition's per-installation form, when it ships one. Absent means
   * this Bot has nothing to configure, which the pane states rather than
   * rendering an empty form.
   */
  configSchema?: Record<string, unknown>
  /**
   * What this installation has stored, unresolved. The defaults are folded in
   * by `resolveBotConfig` at the point of rendering rather than here, so the
   * row keeps saying what the USER set and the form can still show a default
   * as a default.
   */
  config: Record<string, unknown>
  monitor?: BotInstallationRow["monitor"]
  activatedAt?: number
  /** Dead-lettered deliveries waiting for a person to replay or dismiss them. */
  deadLetters: number
  updatedAt: number
}

export interface BotRowInput {
  installation: BotInstallationRow
  /** `null` when the definition is gone. See {@link BotConsoleRow.orphaned}. */
  resolved: InstalledBot | null
  deadLetters?: number
}

/**
 * The literal half of a trigger's description.
 *
 * Returns undefined rather than an empty string when a kind carries no
 * literal, so a caller can tell "nothing to add" from "add this blank".
 */
export function triggerDetail(trigger: PluginBotTriggerDef): string | undefined {
  switch (trigger.kind) {
    case "schedule":
      return trigger.cron
    case "event":
      return trigger.types.join(", ") || undefined
    case "interaction":
      return trigger.adapterTypes?.join(", ") || undefined
    case "derivedState":
      return trigger.state
    case "poll":
      return trigger.cursor
    case "manual":
      return undefined
  }
}

export function summarizeTrigger(
  installation: Pick<BotInstallationRow, "triggerOverrides">,
  trigger: PluginBotTriggerDef
): BotTriggerSummary {
  const everyMs =
    trigger.kind === "poll" || trigger.kind === "derivedState" ? trigger.everyMs : undefined
  const detail = triggerDetail(trigger)
  return {
    id: trigger.id,
    kind: trigger.kind,
    armed: isBotTriggerArmed(installation, trigger),
    ...(trigger.label ? { label: trigger.label } : {}),
    ...(trigger.labelKey ? { labelKey: trigger.labelKey } : {}),
    ...(detail ? { detail } : {}),
    ...(everyMs !== undefined ? { everyMs } : {}),
    ...(trigger.kind === "manual" && trigger.inputSchema
      ? { inputSchema: trigger.inputSchema }
      : {}),
  }
}

export function buildBotRow(input: BotRowInput): BotConsoleRow {
  const { installation, resolved } = input
  const definition = resolved?.definition
  const requiredSlots = definition?.requires?.credentials ?? []
  const triggers = (definition?.triggers ?? []).map((trigger) =>
    summarizeTrigger(installation, trigger)
  )

  const unbound = unboundCredentialSlots(requiredSlots, installation.credentialBindings)

  return {
    id: installation.id,
    definitionId: installation.definitionId,
    source: installation.definitionSource,
    name: definition?.name ?? installation.definitionId,
    ...(definition?.description ? { description: definition.description } : {}),
    ...(definition ? { executor: definition.executor } : {}),
    status: installation.status,
    scope: installation.scope,
    orphaned: !resolved,
    problems: resolved?.problems ?? [],
    triggers,
    armedTriggers: triggers.filter((trigger) => trigger.armed).length,
    unboundSlots: unbound,
    requiredSlots,
    credentials: requiredSlots.map((slot) => {
      const binding = installation.credentialBindings[slot.id]
      return {
        id: slot.id,
        label: slot.label,
        optional: slot.optional === true,
        // An optional slot is never "unbound" as far as status goes, so it is
        // asked directly rather than inferred from the unbound set.
        bound: Boolean(
          binding?.integrationAccountId ?? binding?.authSessionId ?? binding?.adapterId
        ),
        ...(slot.integration ? { integration: slot.integration } : {}),
        ...(slot.strategy ? { strategy: slot.strategy } : {}),
        ...(binding?.integrationAccountId
          ? { integrationAccountId: binding.integrationAccountId }
          : {}),
        ...(binding?.adapterId ? { adapterId: binding.adapterId } : {}),
      }
    }),
    ...(resolved ? { policy: resolved.policyResolution } : {}),
    ...(definition?.configSchema ? { configSchema: definition.configSchema } : {}),
    config: installation.config,
    ...(installation.monitor ? { monitor: installation.monitor } : {}),
    ...(installation.activatedAt !== undefined ? { activatedAt: installation.activatedAt } : {}),
    deadLetters: input.deadLetters ?? 0,
    updatedAt: installation.updatedAt,
  }
}

/** Newest first, the order the installations query already produces. */
export function buildBotRows(inputs: readonly BotRowInput[]): BotConsoleRow[] {
  return inputs.map(buildBotRow).sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Dead letters per installation, from one pass over the delivery rows.
 *
 * A per-row query would be one Dexie read per Bot on every live-query tick,
 * and the console already has the rows in hand.
 */
export function countDeadLettersByInstallation(
  deliveries: readonly Pick<BotEventDeliveryRow, "installationId" | "status">[]
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const delivery of deliveries) {
    if (delivery.status !== "deadletter") continue
    counts[delivery.installationId] = (counts[delivery.installationId] ?? 0) + 1
  }
  return counts
}

export interface BotConsoleSummary {
  total: number
  /** Installations that would run right now if an event arrived. */
  armed: number
  /** The count the header lights up for. */
  needsAttention: number
  deadLetters: number
}

/**
 * What a row needs a person for.
 *
 * `needs_setup` and a dead letter are the two states a user must act on.
 * `version_drift` is deliberately NOT one: the Bot keeps running on the
 * version that exists, and lighting the header for every ordinary plugin
 * update would train the reader to ignore the light. `handler_missing` IS one,
 * because that Bot cannot run at all. An orphan is inert rather than broken,
 * so it does not raise attention either, but it does stop counting as armed.
 */
export function botRowNeedsAttention(row: BotConsoleRow): boolean {
  if (row.monitor?.lastError) return true
  if (row.status === "needs_setup") return true
  if (row.deadLetters > 0) return true
  return row.problems.some((problem) => problem.kind === "handler_missing")
}

/** Can this row actually take work, as opposed to merely existing? */
export function botRowIsArmed(row: BotConsoleRow): boolean {
  if (row.orphaned || row.status !== "enabled") return false
  if (row.problems.some((problem) => problem.kind === "handler_missing")) return false
  return row.armedTriggers > 0
}

export function summarizeBotRows(rows: readonly BotConsoleRow[]): BotConsoleSummary {
  return {
    total: rows.length,
    armed: rows.filter(botRowIsArmed).length,
    needsAttention: rows.filter(botRowNeedsAttention).length,
    deadLetters: rows.reduce((sum, row) => sum + row.deadLetters, 0),
  }
}

/**
 * The list rail's filter axis.
 *
 * `attention` is a filter rather than a sort because it is the reason a person
 * opened the console, and making them scan an unordered list for the badge is
 * the thing the header count exists to avoid.
 */
export type BotStatusFilter = "all" | BotInstallationStatus | "attention"

export const BOT_STATUS_FILTERS: readonly BotStatusFilter[] = [
  "all",
  "enabled",
  "needs_setup",
  "disabled",
  "attention",
]

/** Case-insensitive match over the fields a person would actually type. */
export function matchesBotSearch(row: BotConsoleRow, needle: string): boolean {
  const query = needle.trim().toLowerCase()
  if (!query) return true
  return [row.name, row.definitionId, row.id, row.description, row.executor]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(query))
}

export function filterBotRows(
  rows: readonly BotConsoleRow[],
  search: string,
  status: BotStatusFilter
): BotConsoleRow[] {
  return rows.filter((row) => {
    if (status === "attention" && !botRowNeedsAttention(row)) return false
    if (status !== "all" && status !== "attention" && row.status !== status) return false
    return matchesBotSearch(row, search)
  })
}

/**
 * `attention` here means "this number is why the Bot behaves the way it does",
 * not "this is bad". Zero armed triggers is a working installation that will
 * never fire, and that is exactly the thing the masthead exists to say out
 * loud. Declared locally rather than imported from `components/surface`, the
 * way `lib/devices/device-stats.ts` does, so the model stays free of the view.
 */
export type BotStatTone = "positive" | "attention" | "critical" | "neutral"

export type BotStatId = "triggers" | "credentials" | "deadLetters"

export interface BotStat {
  id: BotStatId
  value: number
  /** Present when the stat is a fraction. Omitted for a plain count. */
  total?: number
  tone: BotStatTone
}

/**
 * The three-or-fewer numbers that summarise one installation.
 *
 * Adaptive rather than fixed width: a Bot that needs no credentials has no
 * credential fraction to print, and a strip that reserved the slot would spend
 * a third of its width on a dash. Only stats the row can actually answer are
 * returned.
 */
export function buildBotStats(row: BotConsoleRow): BotStat[] {
  const stats: BotStat[] = []

  if (row.triggers.length > 0) {
    stats.push({
      id: "triggers",
      value: row.armedTriggers,
      total: row.triggers.length,
      tone: row.armedTriggers === 0 ? "attention" : "positive",
    })
  }

  if (row.requiredSlots.length > 0) {
    const bound = row.requiredSlots.length - row.unboundSlots.length
    stats.push({
      id: "credentials",
      value: bound,
      total: row.requiredSlots.length,
      tone: row.unboundSlots.length > 0 ? "attention" : "positive",
    })
  }

  // Printed only when there are any. A steady "0 dead letters" is noise on a
  // strip whose whole job is to make a shortfall legible.
  if (row.deadLetters > 0) {
    stats.push({ id: "deadLetters", value: row.deadLetters, tone: "critical" })
  }

  return stats
}
