"use client"

/**
 * The external agents on the paired Host, as the phone manages them.
 *
 * These are the Host's own configurations — the same rows the chat composer's
 * runtime menu offers on this phone — so adding, switching, retuning and
 * removing here changes what the phone can actually run. One card per agent:
 * its mark, name and connection on the first line with the on/off switch, and
 * the permission mode and the overflow menu on the second, so neither control
 * has to squeeze into the width the name needs.
 */

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  BotIcon,
  CloudOffIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCwIcon,
  ServerCogIcon,
  Trash2Icon,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import {
  PERMISSION_MODE_LABEL_KEY,
  effectivePermissionMode,
  permissionModesFor,
} from "./permission-modes"
import { ADD_EXTERNAL_AGENT_ROUTE } from "./routes"

function presetOf(record: ExternalAgentConfigRecord): string | null {
  const preset = record.config.metadata?.preset
  return typeof preset === "string" && preset !== "custom" ? preset : null
}

function HostAgentCard({
  record,
  host,
  onRemove,
}: {
  record: ExternalAgentConfigRecord
  host: HostExternalAgentConfigsState
  onRemove: (record: ExternalAgentConfigRecord) => void
}) {
  const t = useTranslations("mobile.externalAgents")
  const config = record.config
  const name = config.name ?? record.configId
  const preset = presetOf(record)
  const protocol = config.protocol
  const mode = effectivePermissionMode(config.defaultPermissionMode, protocol)
  // A config the Host says cannot run must not be switchable on: the Host
  // would refuse the write, and offering the control implies a choice the
  // user does not have. The notice below says why.
  const notReady = record.lifecycleStatus !== "ready"

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
        {preset ? (
          <BrandIcon id={preset} size={32} label={name} />
        ) : (
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <BotIcon className="size-4 text-muted-foreground" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {protocol} · {config.transport}
          </p>
        </div>
        <Switch
          checked={record.enabled}
          disabled={host.busy || notReady}
          onCheckedChange={(enabled) => void write({ enabled })}
          aria-label={t("enabledAria", { name })}
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
            className="h-9 min-w-0 flex-1 text-xs"
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
              className="size-9"
              disabled={host.busy}
              aria-label={t("moreActionsAria", { name })}
              data-testid={`host-agent-menu-${record.configId}`}
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onRemove(record)}
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
  const host = useHostExternalAgentConfigs()
  const [pendingRemoval, setPendingRemoval] = useState<ExternalAgentConfigRecord | null>(null)

  const confirmRemoval = async () => {
    const record = pendingRemoval
    if (!record) return
    setPendingRemoval(null)
    // A refusal is already on screen through `host.error`; only success toasts.
    if (await host.remove(record)) {
      toast.success(t("removed", { name: record.config.name ?? record.configId }))
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
          <Button asChild data-testid="host-agents-empty-add">
            <Link href={ADD_EXTERNAL_AGENT_ROUTE}>
              <PlusIcon className="size-4" />
              {t("add")}
            </Link>
          </Button>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {host.configs.map((record) => (
            <HostAgentCard
              key={record.configId}
              record={record}
              host={host}
              onRemove={setPendingRemoval}
            />
          ))}
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

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteConfirmTitle", {
                name: pendingRemoval?.config.name ?? pendingRemoval?.configId ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmBody", {
                name: pendingRemoval?.config.name ?? pendingRemoval?.configId ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("deleteCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmRemoval()}
              data-testid="host-agent-remove-confirm"
            >
              {t("deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
