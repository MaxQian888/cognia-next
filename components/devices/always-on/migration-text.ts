"use client"

/**
 * The words for moving always-on work (ADR-0224): every blocker, machine-bound
 * reason, note, item kind and journal state, in one place so the device page
 * and the guided flow say the same thing about the same item.
 *
 * Each table is keyed on the full union, so a kind added to the migration
 * vocabulary without a sentence here fails the build rather than rendering a
 * raw key.
 */

import { useTranslations } from "next-intl"
import { useMemo } from "react"

import type { ItemMigrationState } from "@/lib/db/item-migrations"
import type { MachineBoundReason } from "@/lib/placement/machine-bound"
import type {
  MigrationBlocker,
  MigrationNote,
  MigrationReferenceKind,
} from "@/lib/remote-host/migration/types"
import type { OwnedItemKind } from "@/types/placement/item-owner"

/** The translator, narrowed to what these tables call. */
type T = (key: string, values?: Record<string, string | number>) => string

const REASON: {
  [K in MachineBoundReason["kind"]]: (
    t: T,
    r: Extract<MachineBoundReason, { kind: K }>,
    host: string
  ) => string
} = {
  "os-promotion": (t) => t("reason.osPromotion"),
  "task-type-unsupported": (t, r, host) =>
    t("reason.taskTypeUnsupported", { host, taskType: r.taskType }),
  "machine-maintenance": (t) => t("reason.machineMaintenance"),
  "local-process": (t) => t("reason.localProcess"),
  "managed-by": (t, r) => t("reason.managedBy", { manager: t(`kind.${r.manager}`) }),
  "local-event": (t, r) => t("reason.localEvent", { eventType: r.eventType }),
  "desktop-trigger": (t, r) => t("reason.desktopTrigger", { triggerId: r.triggerId }),
  "local-path": (t, r) => t("reason.localPath", { path: r.path }),
  "local-project-root": (t, r) => t("reason.localProjectRoot", { path: r.path }),
  "stdio-mcp": (t, r) => t("reason.stdioMcp", { name: r.name }),
  "keyring-reference": (t, r) => t("reason.keyringReference", { ref: r.ref }),
  "loopback-endpoint": (t, r) => t("reason.loopbackEndpoint", { url: r.url }),
  "webhook-endpoint": (t) => t("reason.webhookEndpoint"),
}

const REFERENCE: Record<MigrationReferenceKind, string> = {
  workflow: "reference.workflow",
  character: "reference.character",
  skill: "reference.skill",
  "agent-team": "reference.agentTeam",
  plan: "reference.plan",
  conversation: "reference.conversation",
  "mcp-server": "reference.mcpServer",
  "external-agent": "reference.externalAgent",
  workspace: "reference.workspace",
  "integration-account": "reference.integrationAccount",
  "connector-instance": "reference.connectorInstance",
}

const BLOCKER: {
  [K in MigrationBlocker["kind"]]: (
    t: T,
    b: Extract<MigrationBlocker, { kind: K }>,
    host: string
  ) => string
} = {
  "host-unreachable": (t, b, host) => t("blocker.hostUnreachable", { host, detail: b.detail }),
  "host-too-old": (t, _b, host) => t("blocker.hostTooOld", { host }),
  "already-moved": (t, b) => t("blocker.alreadyMoved", { host: b.hostLabel }),
  "machine-bound": (t, b, host) => reasonText(t, b.reason, host),
  "plugin-missing": (t, b, host) =>
    t("blocker.pluginMissing", { host, pluginId: b.pluginId, version: b.version }),
  "plugin-version-mismatch": (t, b, host) =>
    t("blocker.pluginVersionMismatch", {
      host,
      pluginId: b.pluginId,
      version: b.version,
      hostVersion: b.hostVersion,
    }),
  "bot-definition-missing": (t, b, host) =>
    t("blocker.botDefinitionMissing", { host, definitionId: b.definitionId, version: b.version }),
  "reference-missing": (t, b, host) =>
    t("blocker.referenceMissing", {
      host,
      reference: t(REFERENCE[b.reference]),
      id: b.id,
    }),
  "depends-on": (t, b) => t("blocker.dependsOn", { label: b.label }),
  "id-conflict": (t, b, host) => t("blocker.idConflict", { host, id: b.id }),
  "secret-unreadable": (t, b) => t("blocker.secretUnreadable", { name: b.name }),
}

const NOTE: {
  [K in MigrationNote["kind"]]: (
    t: T,
    n: Extract<MigrationNote, { kind: K }>,
    host: string
  ) => string
} = {
  "conversation-address-relearned": (t, n) =>
    t("note.conversationAddressRelearned", { conversationKey: n.conversationKey }),
  "secret-transferred": (t, n, host) => t("note.secretTransferred", { name: n.name, host }),
  "schedules-travel": (t, n, host) => t("note.schedulesTravel", { count: n.count, host }),
  "workspace-travels": (t, n, host) =>
    t("note.workspaceTravels", { workspace: n.workspace, remoteUrl: n.remoteUrl, host }),
}

const STATE: Record<ItemMigrationState, string> = {
  prepared: "state.prepared",
  created: "state.created",
  fenced: "state.fenced",
  completed: "state.completed",
  "awaiting-host": "state.awaitingHost",
  failed: "state.failed",
}

function reasonText(t: T, reason: MachineBoundReason, host: string): string {
  return (REASON[reason.kind] as (t: T, r: MachineBoundReason, host: string) => string)(
    t,
    reason,
    host
  )
}

export interface MigrationText {
  blocker: (blocker: MigrationBlocker, host: string) => string
  note: (note: MigrationNote, host: string) => string
  kind: (kind: OwnedItemKind) => string
  state: (state: ItemMigrationState) => string
}

export function useMigrationText(): MigrationText {
  const t = useTranslations("devices.alwaysOn") as unknown as T
  return useMemo(
    () => ({
      blocker: (blocker, host) =>
        (BLOCKER[blocker.kind] as (t: T, b: MigrationBlocker, host: string) => string)(
          t,
          blocker,
          host
        ),
      note: (note, host) =>
        (NOTE[note.kind] as (t: T, n: MigrationNote, host: string) => string)(t, note, host),
      kind: (kind) => t(`kind.${kind}`),
      state: (state) => t(STATE[state]),
    }),
    [t]
  )
}
