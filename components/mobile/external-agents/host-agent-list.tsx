"use client"

/**
 * The external agents on the paired Host, as the phone manages them.
 *
 * These are the Host's own configurations — the same rows the chat composer's
 * runtime menu offers on this phone — so adding, switching, retuning and
 * removing here changes what the phone can actually run. One card per agent:
 * its mark, name, connection and the facts that tell it from a sibling
 * configuration (own or shared state, "copy of …") on the first line, which
 * opens the agent's detail screen; the on/off switch beside it; and the
 * permission mode and the overflow menu (edit, duplicate, remove) on the
 * second, so no control has to squeeze into the width the name needs.
 *
 * Several configurations of one runtime (ADR-0216) are drawn under one header
 * naming the runtime, so two cards with the same mark read as two setups of
 * one thing rather than as a duplicate row.
 *
 * The card's link covers only the identity block, and the switch, select and
 * menu sit outside it: an interactive control nested in a link is announced
 * twice and its taps also navigate.
 */

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  BotIcon,
  ChevronRightIcon,
  CloudOffIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  ServerCogIcon,
  Trash2Icon,
} from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { BrandIcon } from "@/components/icons/brand-icon"
import { LifecycleStatusNotice } from "@/components/agent/external-agent/lifecycle-status-notice"
import {
  useHostExternalAgentConfigs,
  type HostExternalAgentConfigsState,
} from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type { AcpPermissionMode } from "@/types/agent/external-agent"

import { HOST_UNAVAILABLE_KEY } from "./add-external-agent-form"
import { DuplicateHostAgentSheet } from "./duplicate-host-agent-sheet"
import { HostAgentIsolationChip, useRuntimeName } from "./host-agent-chips"
import {
  groupHostConfigsByRuntime,
  hostAgentName,
  lineageSourceOf,
  presetOf,
} from "./host-agent-family"
import {
  PERMISSION_MODE_LABEL_KEY,
  effectivePermissionMode,
  permissionModesFor,
} from "./permission-modes"
import { RemoveHostAgentDialog } from "./remove-host-agent-dialog"
import { ADD_EXTERNAL_AGENT_ROUTE, externalAgentDetailHref } from "./routes"

function HostAgentCard({
  record,
  host,
  onDuplicate,
  onRemove,
}: {
  record: ExternalAgentConfigRecord
  host: HostExternalAgentConfigsState
  onDuplicate: (record: ExternalAgentConfigRecord) => void
  onRemove: (record: ExternalAgentConfigRecord) => void
}) {
  const t = useTranslations("mobile.externalAgents")
  const config = record.config
  const name = hostAgentName(record)
  const preset = presetOf(record)
  const protocol = config.protocol
  const mode = effectivePermissionMode(config.defaultPermissionMode, protocol)
  // A config the Host says cannot run must not be switchable on: the Host
  // would refuse the write, and offering the control implies a choice the
  // user does not have. The notice below says why.
  const notReady = record.lifecycleStatus !== "ready"
  const source = lineageSourceOf(record, host.configs)
  const href = externalAgentDetailHref(record.configId)

  const write = async (patch: { enabled?: boolean; defaultPermissionMode?: AcpPermissionMode }) => {
    const ok = await host.update(record, patch)
    if (ok) toast.success(t("updateQueued"))
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border bg-card p-3"
      data-testid={`host-agent-${record.configId}`}
    >
      <div className="flex items-center gap-3">
        <Link
          href={href}
          className="-m-1 flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg p-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-muted/60"
          aria-label={t("openDetailsAria", { name })}
          data-testid={`host-agent-open-${record.configId}`}
        >
          {preset ? (
            <BrandIcon id={preset} size={32} label={name} />
          ) : (
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <BotIcon className="size-4 text-muted-foreground" aria-hidden />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {protocol} · {config.transport}
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
              <HostAgentIsolationChip record={record} />
              {source && source !== "removed" ? (
                <span
                  className="truncate text-[11px] text-muted-foreground"
                  data-testid={`host-agent-lineage-${record.configId}`}
                >
                  {t("copyOf", { name: hostAgentName(source) })}
                </span>
              ) : null}
            </span>
          </span>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Link>
        <Switch
          checked={record.enabled}
          disabled={host.busy || notReady}
          onCheckedChange={(enabled) => void write({ enabled })}
          aria-label={t("enabledAria", { name })}
          className="touch-hit"
          data-testid={`host-agent-switch-${record.configId}`}
        />
      </div>

      {notReady ? (
        <LifecycleStatusNotice
          status={record.lifecycleStatus}
          reasonCode={config.lifecycleReasonCode}
        />
      ) : null}

      <div className="flex items-center gap-2">
        <Select
          value={mode}
          disabled={host.busy}
          onValueChange={(value) => void write({ defaultPermissionMode: value as AcpPermissionMode })}
        >
          <SelectTrigger
            className="h-11 min-w-0 flex-1 text-xs"
            aria-label={t("permissionModeAria", { name })}
            data-testid={`host-agent-mode-${record.configId}`}
          >
            <span className="text-muted-foreground">{t("permissionLabel")}</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {permissionModesFor(protocol).map((option) => (
              <SelectItem key={option} value={option}>
                {t(PERMISSION_MODE_LABEL_KEY[option])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              disabled={host.busy}
              aria-label={t("moreActionsAria", { name })}
              data-testid={`host-agent-menu-${record.configId}`}
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild className="min-h-11">
              <Link
                href={href}
                aria-label={t("editAria", { name })}
                data-testid={`host-agent-edit-${record.configId}`}
              >
                <PencilIcon className="size-4" />
                {t("edit")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              onSelect={() => onDuplicate(record)}
              aria-label={t("duplicateAria", { name })}
              data-testid={`host-agent-duplicate-${record.configId}`}
            >
              <CopyIcon className="size-4" />
              {t("duplicate")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              className="min-h-11"
              onSelect={() => onRemove(record)}
              aria-label={t("removeAria", { name })}
              data-testid={`host-agent-remove-${record.configId}`}
            >
              <Trash2Icon className="size-4" />
              {t("deleteConfirm")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * The cards, under a runtime header wherever a runtime has two or more
 * configurations. A lone configuration needs no header: its card already
 * carries the runtime's mark.
 */
function HostAgentCards({
  host,
  onDuplicate,
  onRemove,
}: {
  host: HostExternalAgentConfigsState
  onDuplicate: (record: ExternalAgentConfigRecord) => void
  onRemove: (record: ExternalAgentConfigRecord) => void
}) {
  const t = useTranslations("mobile.externalAgents")
  const runtimeName = useRuntimeName()
  return (
    <>
      {groupHostConfigsByRuntime(host.configs).map((group) => {
        const cards = group.records.map((record) => (
          <HostAgentCard
            key={record.configId}
            record={record}
            host={host}
            onDuplicate={onDuplicate}
            onRemove={onRemove}
          />
        ))
        if (group.records.length < 2) return cards
        const label = runtimeName(group.runtime, hostAgentName(group.records[0]))
        const headingId = `host-agent-group-${group.runtime.key}`
        return (
          <div
            key={group.runtime.key}
            role="group"
            aria-labelledby={headingId}
            className="flex flex-col gap-2"
            data-testid={`host-agent-group-${group.runtime.key}`}
          >
            <p
              id={headingId}
              className="flex items-baseline justify-between gap-2 px-1 pt-1 text-xs font-medium"
            >
              <span className="truncate">{label}</span>
              <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
                {t("groupCount", { count: group.records.length })}
              </span>
            </p>
            {cards}
          </div>
        )
      })}
    </>
  )
}

function LoadingCards() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" data-testid="host-agents-loading">
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  )
}

export function HostAgentList() {
  const t = useTranslations("mobile.externalAgents")
  const tHost = useTranslations("externalAgent.hostConfigs")
  const router = useRouter()
  const host = useHostExternalAgentConfigs()
  const [pendingRemoval, setPendingRemoval] = useState<ExternalAgentConfigRecord | null>(null)
  const [duplicating, setDuplicating] = useState<ExternalAgentConfigRecord | null>(null)

  const confirmRemoval = async (record: ExternalAgentConfigRecord) => {
    setPendingRemoval(null)
    // A refusal is already on screen through `host.error`; only success toasts.
    if (await host.remove(record)) {
      toast.success(t("removed", { name: hostAgentName(record) }))
    }
  }

  if (host.unavailable) {
    return (
      <Empty className="rounded-xl border" data-testid="host-agents-unavailable">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ServerCogIcon />
          </EmptyMedia>
          <EmptyTitle>{tHost("unavailableTitle")}</EmptyTitle>
          <EmptyDescription>{tHost(HOST_UNAVAILABLE_KEY[host.unavailable])}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  // A failed read leaves no rows and no load in flight; a failed write re-reads
  // first, so it normally keeps them. Telling the two apart here keeps a load
  // failure from reading "could not save" above an "add your first agent" box
  // that says the Host has none, which it was never able to say.
  const loadFailed = host.error !== null && !host.loading && host.configs.length === 0

  return (
    // Not `MeSection`: that wraps its rows in a bordered surface, and these
    // are cards of their own — a card inside a card read as a double border.
    <section className="flex flex-col gap-2" data-testid="host-agents-section">
      <h2 className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {t("hostSectionTitle")}
      </h2>
      {host.error && host.configs.length > 0 ? (
        <Alert variant="destructive" data-testid="host-agents-error">
          <AlertDescription>{t("toggleFailed", { message: host.error })}</AlertDescription>
        </Alert>
      ) : null}
      {loadFailed ? (
        <Empty className="rounded-xl border" data-testid="host-agents-load-failed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudOffIcon />
            </EmptyMedia>
            <EmptyTitle>{t("loadFailedTitle")}</EmptyTitle>
            <EmptyDescription className="break-words">
              {t("loadFailed", { message: host.error ?? "" })}
            </EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => void host.refresh()}
            data-testid="host-agents-retry"
          >
            <RotateCwIcon className="size-4" />
            {t("retry")}
          </Button>
        </Empty>
      ) : host.loading && host.configs.length === 0 ? (
        <LoadingCards />
      ) : host.configs.length === 0 ? (
        <Empty className="rounded-xl border" data-testid="host-agents-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button asChild className="h-11" data-testid="host-agents-empty-add">
            <Link href={ADD_EXTERNAL_AGENT_ROUTE}>
              <PlusIcon className="size-4" />
              {t("add")}
            </Link>
          </Button>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          <HostAgentCards host={host} onDuplicate={setDuplicating} onRemove={setPendingRemoval} />
          <Button
            asChild
            variant="outline"
            className="h-11 border-dashed"
            data-testid="host-agents-add"
          >
            <Link href={ADD_EXTERNAL_AGENT_ROUTE}>
              <PlusIcon className="size-4" />
              {t("add")}
            </Link>
          </Button>
        </div>
      )}

      <RemoveHostAgentDialog
        record={pendingRemoval}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={(record) => void confirmRemoval(record)}
      />
      <DuplicateHostAgentSheet
        record={duplicating}
        records={host.configs}
        duplicate={host.duplicate}
        onClose={() => setDuplicating(null)}
        onDuplicated={(created) => {
          setDuplicating(null)
          router.push(externalAgentDetailHref(created.configId))
        }}
      />
    </section>
  )
}
