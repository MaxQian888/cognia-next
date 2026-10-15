"use client"

/**
 * The paired Host's configurations, grouped by runtime (ADR-0216). Identity
 * links open details; switches and overflow actions stay outside the links.
 * Search and state filters keep the runtime grouping and the source records
 * used by duplicate, lineage and compare-and-swap updates.
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
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { BrandIcon } from "@/components/icons/brand-icon"
import { InstanceTraitChips } from "@/components/agent/external-agent/instance-traits"
import {
  distinguishingTraits,
  runtimeSiblings,
  type InstanceFamilyConfig,
} from "@/lib/ai/agent/external/config/instance-family"
import {
  useHostExternalAgentConfigs,
  type HostExternalAgentConfigsState,
} from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { HOST_UNAVAILABLE_KEY } from "./add-external-agent-form"
import { DuplicateHostAgentSheet } from "./duplicate-host-agent-sheet"
import { HostAgentIsolationChip, useRuntimeName } from "./host-agent-chips"
import {
  groupHostConfigsByRuntime,
  hostAgentName,
  lineageSourceOf,
  presetOf,
} from "./host-agent-family"
import { RemoveHostAgentDialog } from "./remove-host-agent-dialog"
import { ADD_EXTERNAL_AGENT_ROUTE, externalAgentDetailHref } from "./routes"

function HostAgentRow({
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
  // A config the Host says cannot run must not be switchable on: the Host
  // would refuse the write, and offering the control implies a choice the
  // user does not have. The detail explains the lifecycle verdict.
  const notReady = record.lifecycleStatus !== "ready"
  const source = lineageSourceOf(record, host.configs)
  const href = externalAgentDetailHref(record.configId)
  const member = { ...config, id: record.configId } as InstanceFamilyConfig
  const members = host.configs.map((row) => ({
    ...row.config,
    id: row.configId,
  })) as InstanceFamilyConfig[]
  const traits = distinguishingTraits(member, runtimeSiblings(member, members)).filter(
    ({ key }) => key !== "stateIsolation"
  )

  const write = async (patch: { enabled: boolean }) => {
    const ok = await host.update(record, patch)
    if (ok) toast.success(t("updateQueued"))
  }

  return (
    <div
      className="flex min-w-0 items-center gap-1 px-3 py-3 @min-[380px]:gap-2"
      data-testid={`host-agent-${record.configId}`}
    >
      <Link
        href={href}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-muted/60"
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
          <span className="block text-[11px] text-muted-foreground">
            {t(notReady ? "stateAttention" : record.enabled ? "stateOn" : "stateOff")}
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
          <InstanceTraitChips
            traits={traits}
            max={traits.length}
            className="mt-1 [&_[data-slot=badge]]:max-w-full"
          />
        </span>
        <ChevronRightIcon
          className="hidden size-4 shrink-0 text-muted-foreground @min-[380px]:block"
          aria-hidden
        />
      </Link>
      <label className="flex size-11 shrink-0 items-center justify-center">
        <Switch
          checked={record.enabled}
          disabled={host.busy || notReady}
          onCheckedChange={(enabled) => void write({ enabled })}
          aria-label={t("enabledAria", { name })}
          className="touch-hit"
          data-testid={`host-agent-switch-${record.configId}`}
        />
      </label>
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
  )
}

function HostAgentRows({
  records,
  host,
  onDuplicate,
  onRemove,
}: {
  records: ExternalAgentConfigRecord[]
  host: HostExternalAgentConfigsState
  onDuplicate: (record: ExternalAgentConfigRecord) => void
  onRemove: (record: ExternalAgentConfigRecord) => void
}) {
  const t = useTranslations("mobile.externalAgents")
  const runtimeName = useRuntimeName()
  return (
    <>
      {groupHostConfigsByRuntime(records).map((group) => {
        const label = runtimeName(group.runtime, hostAgentName(group.records[0]))
        const headingId = `host-agent-group-${group.runtime.key}`
        return (
          <div
            key={group.runtime.key}
            role="group"
            aria-labelledby={headingId}
            className="flex min-w-0 flex-col gap-2"
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
            <div className="divide-y overflow-hidden rounded-xl border bg-card">
              {group.records.map((record) => (
                <HostAgentRow
                  key={record.configId}
                  record={record}
                  host={host}
                  onDuplicate={onDuplicate}
                  onRemove={onRemove}
                />
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

function LoadingRows() {
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
  const [query, setQuery] = useState("")
  const [stateFilter, setStateFilter] = useState("all")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleConfigs = host.configs.filter((record) => {
    const matchesQuery = [
      hostAgentName(record),
      record.config.description,
      record.config.protocol,
      record.config.transport,
      presetOf(record),
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
    const matchesState =
      stateFilter === "all" ||
      (stateFilter === "attention" && record.lifecycleStatus !== "ready") ||
      (stateFilter === "on" && record.enabled) ||
      (stateFilter === "off" && !record.enabled)
    return matchesQuery && matchesState
  })

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

  // An empty Host is known only after a successful read; a first-load failure
  // cannot make that claim. Refresh failures retain the last successful list.
  const loadFailed = host.error !== null && !host.loading && !host.loaded

  return (
    <section className="@container flex min-w-0 flex-col gap-2" data-testid="host-agents-section">
      <h2 className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {t("hostSectionTitle")}
      </h2>
      {host.error && host.loaded ? (
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
      ) : !host.loaded || (host.loading && host.configs.length === 0) ? (
        <LoadingRows />
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
          <div className="grid min-w-0 gap-2 @min-[380px]:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAria")}
              className="h-11 min-w-0"
            />
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger
                className="min-h-11 w-full @min-[380px]:w-40"
                aria-label={t("stateFilterAria")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="min-h-11">
                  {t("stateAll")}
                </SelectItem>
                <SelectItem value="attention" className="min-h-11">
                  {t("stateAttention")}
                </SelectItem>
                <SelectItem value="on" className="min-h-11">
                  {t("stateOn")}
                </SelectItem>
                <SelectItem value="off" className="min-h-11">
                  {t("stateOff")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {visibleConfigs.length === 0 ? (
            <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("noFilterMatches")}
            </p>
          ) : (
            <HostAgentRows
              records={visibleConfigs}
              host={host}
              onDuplicate={setDuplicating}
              onRemove={setPendingRemoval}
            />
          )}
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
