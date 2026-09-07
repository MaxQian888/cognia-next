/**
 * Every Bot status, executor, trigger kind, scope, source, problem, stat and
 * runtime reach must have a label, in both locales.
 *
 * The console renders `t(\`status.${status}\`)`, `t(\`executor.${executor}\`)`,
 * `t(\`trigger.kind.${kind}\`)`, `t(\`scope.${kind}\`)`, `t(\`source.${source}\`)`,
 * `t(\`problem.${kind}.title\`)`, `t(\`stat.${id}\`)` and
 * `t(\`runtime.${reach}.title\`)`. All of them are DYNAMIC keys, which
 * `pnpm lint:i18n` does not see, so a seventh trigger kind added without a
 * label would ship a row reading `trigger.kind.whatever` and pass every gate.
 *
 * The values are walked from their own source of truth wherever one can be
 * imported at runtime, and pinned against the type otherwise: a union is
 * erased at compile time, so a hand-kept list is the only thing left, and the
 * `satisfies` below is what makes a missing entry a type error.
 */

import en from "@/i18n/messages/en/bots.json"
import zh from "@/i18n/messages/zh-CN/bots.json"
import { BOT_STATUS_FILTERS, type BotStatId, type BotTriggerKind } from "@/lib/bot/console/bot-rows"
import { BOT_POLICY_LAYERS } from "@/lib/bot/policy/ceilings"
import type { BotRuntimeReach } from "@/lib/bot/console/runtime-reach"
import type { OperationAvailabilityReason } from "@/lib/runtime/operation-availability"
import type {
  BotDefinitionSource,
  BotDeliveryStatus,
  BotInstallationStatus,
  BotScopeKind,
} from "@/lib/db/bot-types"
import type { BotResolutionProblem } from "@/lib/bot/installed-bot"
import type { PluginBotExecutor, PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

const STATUSES = [
  "enabled",
  "disabled",
  "needs_setup",
] as const satisfies readonly BotInstallationStatus[]

const EXECUTORS = [
  "workflow",
  "squad",
  "agent-turn",
  "handler",
] as const satisfies readonly PluginBotExecutor[]

const TRIGGER_KINDS = [
  "interaction",
  "event",
  "schedule",
  "poll",
  "derivedState",
  "manual",
] as const satisfies readonly BotTriggerKind[]

const SCOPES = ["account", "workspace", "project"] as const satisfies readonly BotScopeKind[]

const SOURCES = ["plugin", "local"] as const satisfies readonly BotDefinitionSource[]

const PROBLEMS = [
  "definition_missing",
  "version_drift",
  "handler_missing",
] as const satisfies readonly BotResolutionProblem["kind"][]

const STATS = ["triggers", "credentials", "deadLetters"] as const satisfies readonly BotStatId[]

/**
 * Mirrors `policy-section.tsx`'s own `POLICY_FIELDS`, which is itself
 * `satisfies readonly (keyof PluginBotPolicyV1)[]`. A field added to the
 * policy and rendered without a label prints its own key.
 */
const POLICY_FIELDS = [
  "maxAuthority",
  "maxAutonomy",
  "maxRunDurationMs",
  "maxRunCostUsd",
  "maxConcurrentRuns",
  "requireApprovalForWrites",
  "allowSelfTriggering",
] as const satisfies readonly (keyof PluginBotPolicyV1)[]

/** `local` is deliberately absent: the notice renders nothing for it. */
const REACHES = ["remote", "paired", "none"] as const satisfies readonly BotRuntimeReach[]

const DELIVERY_STATUSES = [
  "pending",
  "leased",
  "running",
  "parked",
  "succeeded",
  "failed",
  "deadletter",
  "dismissed",
] as const satisfies readonly BotDeliveryStatus[]

/**
 * Every reason `resolveOperationAvailability` and the Bot route can produce.
 *
 * The console prints one of these verbatim whenever a control refuses, so a
 * reason with no entry ships a paragraph reading `write.reason.vault-locked`
 * at exactly the moment a user is already stuck.
 */
const WRITE_REASONS = [
  "local-executor",
  "local-host",
  "requires-companion",
  "legacy-readonly",
  "vault-locked",
  "companion-not-paired",
  "host-protocol",
  "host-manifest-missing",
  "operation-unavailable",
  "missing-grant",
  "offline-cache",
  "offline-queue",
  "connection-offline",
  "service-only",
  "host-admin-only",
  "unknown-command",
] as const satisfies readonly OperationAvailabilityReason[]

type Catalogue = {
  status: Record<string, string>
  executor: Record<string, string>
  trigger: { kind: Record<string, string> }
  scope: Record<string, string>
  source: Record<string, string>
  problem: Record<string, { title: string; body: string; badge?: string }>
  stat: Record<string, string>
  runtime: Record<string, { title: string; body: string }>
  listPane: { filter: Record<string, string> }
  policyField: Record<string, string>
  policyLayer: Record<string, string>
  delivery: { status: Record<string, string> }
  write: { reason: Record<string, string> }
}

const catalogues: Record<string, Catalogue> = {
  en: en as unknown as Catalogue,
  "zh-CN": zh as unknown as Catalogue,
}

describe.each(Object.entries(catalogues))("bots catalogue (%s)", (_locale, catalogue) => {
  it.each(STATUSES)("labels the %s status", (status) => {
    expect(typeof catalogue.status[status]).toBe("string")
  })

  it.each(EXECUTORS)("labels the %s executor", (executor) => {
    expect(typeof catalogue.executor[executor]).toBe("string")
  })

  it.each(TRIGGER_KINDS)("labels the %s trigger kind", (kind) => {
    expect(typeof catalogue.trigger.kind[kind]).toBe("string")
  })

  it.each(SCOPES)("labels the %s scope", (scope) => {
    expect(typeof catalogue.scope[scope]).toBe("string")
  })

  it.each(SOURCES)("labels the %s source", (source) => {
    expect(typeof catalogue.source[source]).toBe("string")
  })

  it.each(PROBLEMS)("gives the %s problem a title and a body", (kind) => {
    expect(typeof catalogue.problem[kind]?.title).toBe("string")
    expect(typeof catalogue.problem[kind]?.body).toBe("string")
  })

  it.each(STATS)("labels the %s stat", (id) => {
    expect(typeof catalogue.stat[id]).toBe("string")
  })

  it.each(REACHES)("gives the %s runtime reach a title and a body", (reach) => {
    expect(typeof catalogue.runtime[reach]?.title).toBe("string")
    expect(typeof catalogue.runtime[reach]?.body).toBe("string")
  })

  it.each(BOT_STATUS_FILTERS)("labels the %s list filter", (filter) => {
    expect(typeof catalogue.listPane.filter[filter]).toBe("string")
  })

  it.each(POLICY_FIELDS)("labels the %s policy field", (field) => {
    expect(typeof catalogue.policyField[field]).toBe("string")
  })

  it.each(BOT_POLICY_LAYERS)("labels the %s policy layer", (layer) => {
    expect(typeof catalogue.policyLayer[layer]).toBe("string")
  })

  it.each(DELIVERY_STATUSES)("labels the %s delivery status", (status) => {
    expect(typeof catalogue.delivery.status[status]).toBe("string")
  })

  it.each(WRITE_REASONS)("explains the %s write refusal", (reason) => {
    expect(typeof catalogue.write.reason[reason]).toBe("string")
  })

  it("carries the orphan badge, which is not a fourth status", () => {
    // Rendered by `BotOrphanBadge`. An installation whose definition is gone
    // is inert, not disabled, so it needs a word of its own.
    expect(typeof catalogue.problem.definition_missing?.badge).toBe("string")
  })
})

describe("catalogue coverage", () => {
  it("walks a non-empty list for every axis", () => {
    // A sweep that scanned nothing also passes every assertion above.
    for (const list of [
      STATUSES,
      EXECUTORS,
      TRIGGER_KINDS,
      SCOPES,
      SOURCES,
      PROBLEMS,
      STATS,
      REACHES,
    ]) {
      expect(list.length).toBeGreaterThan(0)
    }
    expect(Object.keys(catalogues)).toEqual(["en", "zh-CN"])
  })
})
