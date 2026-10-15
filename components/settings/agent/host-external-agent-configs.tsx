"use client"

/**
 * External agents the HOST owns, as seen from this client.
 *
 * The sibling panel above this one lists agents configured in *this* browser's
 * local store. They look similar and are not the same thing: a local agent can
 * only run where its process can be spawned, so on a browser it is a
 * configuration with nowhere to go. These rows live on the paired host, which
 * is also what runs them — which is why this panel can show a readiness verdict
 * at all, and the local one cannot promise one.
 *
 * The panel is rendered whenever a host is reachable, including when that host
 * is too old to serve it. Hiding it there would collapse three different
 * situations — no host paired, host still handshaking, host too old — into an
 * absence the user cannot act on.
 */

import { useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  CopyPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
  Upload,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/sonner"
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
import { LifecycleStatusNotice } from "@/components/agent/external-agent/lifecycle-status-notice"
import { PresetPickerList } from "@/components/agent/external-agent/add-agent/preset-picker-list"
import { HostAgentCreateForm } from "@/components/agent/external-agent/host/host-agent-create-form"
import { HostAgentEditor } from "@/components/agent/external-agent/host/host-agent-editor"
import {
  PERMISSION_MODE_LABEL_KEY,
  effectivePermissionMode,
  permissionModesFor,
} from "@/components/mobile/external-agents/permission-modes"
import {
  DuplicatedFromHint,
  InstanceTraitChips,
  StateIsolationBadge,
  useInstanceTraitLine,
  type InstanceTrait,
} from "@/components/agent/external-agent/instance-traits"
import { DuplicateAgentDialog } from "./duplicate-agent-dialog"
import { useHostExternalAgentConfigs } from "@/hooks/agent/use-host-external-agent-configs"
import { pairRuntimeConfigs } from "@/lib/ai/agent/runtime-catalog/pairing"
import {
  distinguishingTraits,
  runtimeSiblings,
  type InstanceFamilyConfig,
} from "@/lib/ai/agent/external/config/instance-family"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { hydrateAgentConfig, selectAgents } from "@/stores/agent/external-agent-store/selectors"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type { AcpPermissionMode, ExternalAgentConfig } from "@/types/agent/external-agent"
import type { HostConfigsUnavailableReason } from "@/lib/ai/agent/external/runtimes/remote/remote-host-configs"

const UNAVAILABLE_KEY: Record<HostConfigsUnavailableReason, string> = {
  "no-host": "unavailableNoHost",
  unsupported: "unavailableUnsupported",
  "manifest-missing": "unavailableManifestMissing",
}

/** A host record read as a member of a runtime family: its id is the record's. */
function familyMember(record: ExternalAgentConfigRecord): InstanceFamilyConfig {
  return { ...record.config, id: record.configId } as InstanceFamilyConfig
}

function displayName(record: ExternalAgentConfigRecord): string {
  return record.config.name ?? record.configId
}

/**
 * A host record as the duplicate dialog reads a configuration. The Host does
 * the copying (secrets included); the dialog only collects the name, state
 * and enablement, so the choices read the same as for a local copy.
 */
function duplicateSource(record: ExternalAgentConfigRecord): ExternalAgentConfig {
  return hydrateAgentConfig({
    ...record.config,
    id: record.configId,
    name: displayName(record),
    enabled: record.enabled,
  })
}

function HostConfigRow({
  record,
  busy,
  sourceName,
  traits,
  highlighted,
  onToggle,
  onPermissionChange,
  onEdit,
  onRemove,
  onDuplicate,
}: {
  record: ExternalAgentConfigRecord
  busy: boolean
  /** The configuration this one was duplicated from, when it still exists. */
  sourceName: string | null
  /** What sets it apart from the host's other configurations of its runtime. */
  traits: readonly InstanceTrait[]
  highlighted: boolean
  onToggle: (next: boolean) => void
  onPermissionChange: (mode: AcpPermissionMode) => void
  onEdit: () => void
  onRemove: () => void
  onDuplicate: () => void
}) {
  const t = useTranslations("externalAgent.hostConfigs")
  const tManage = useTranslations("externalAgentManage.hostConfigs")
  const tMobile = useTranslations("mobile.externalAgents")
  const tCommon = useTranslations("common")
  // No cast: `record.config` is a `StoredExternalAgentConfig`, which already
  // types `name`, `protocol` and the lifecycle fields read below.
  const config = record.config
  const name = displayName(record)
  const notReady = record.lifecycleStatus !== "ready"

  return (
    <Item
      className="rounded-none border-0 px-0 data-[highlighted=true]:bg-accent/60 @max-md/settings-stack:flex-col @max-md/settings-stack:items-stretch"
      data-testid={`host-config-${record.configId}`}
      data-highlighted={highlighted}
    >
      <ItemContent className="min-w-0">
        {/* `min-w-0` on the content, not on the title: the title's own
            intrinsic width is what defeats truncation inside an Item. */}
        <ItemTitle className="min-w-0 truncate">{name}</ItemTitle>
        <ItemDescription className="flex flex-wrap items-center gap-2">
          {config.protocol ? <Badge variant="outline">{config.protocol}</Badge> : null}
          <StateIsolationBadge config={config} />
          {/* The revision is what a run is admitted against, so it is the one
              piece of bookkeeping worth showing: it is what a "someone else
              edited this" conflict will name. */}
          <span className="font-mono text-xs">{t("revision", { seq: record.seq })}</span>
        </ItemDescription>
        <InstanceTraitChips traits={traits} className="mt-1" />
        <DuplicatedFromHint sourceName={sourceName} className="mt-1" />
        <LifecycleStatusNotice
          status={record.lifecycleStatus}
          reasonCode={record.config.lifecycleReasonCode}
          className="mt-2"
        />
      </ItemContent>
      <ItemActions className="min-w-0 flex-wrap gap-2 @max-md/settings-stack:justify-end">
        <Select
          value={effectivePermissionMode(config.defaultPermissionMode, config.protocol)}
          disabled={busy}
          onValueChange={(value) => onPermissionChange(value as AcpPermissionMode)}
        >
          <SelectTrigger
            className="min-w-0 max-w-full text-xs @max-md/settings-stack:flex-1"
            aria-label={tMobile("permissionModeAria", { name })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {permissionModesFor(config.protocol).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {tMobile(PERMISSION_MODE_LABEL_KEY[mode])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Switch
          checked={record.enabled}
          // A config the host says cannot run must not be switchable on: the
          // host would refuse the write, and offering the control implies a
          // choice the user does not have. The notice above says why.
          disabled={busy || notReady}
          onCheckedChange={onToggle}
          aria-label={t("toggleLabel", { name })}
        />
        <Button
          variant="ghost"
          size="sm"
          className="touch-hit"
          disabled={busy}
          onClick={onEdit}
          aria-label={t("editLabel", { name })}
        >
          <Pencil className="size-4" />
          {tCommon("edit")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="touch-hit"
              disabled={busy}
              aria-label={t("actionsLabel", { name })}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={onDuplicate}
              aria-label={tManage("duplicateLabel", { name })}
            >
              <CopyPlus className="size-4" />
              {tMobile("duplicate")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={onRemove}
              aria-label={t("deleteLabel", { name })}
            >
              <Trash2 className="size-4" />
              {tCommon("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ItemActions>
    </Item>
  )
}

export function HostExternalAgentConfigs({ title }: { title?: string } = {}) {
  const t = useTranslations("externalAgent.hostConfigs")
  const tManage = useTranslations("externalAgentManage.hostConfigs")
  const tCommon = useTranslations("common")
  const traitLine = useInstanceTraitLine()
  const {
    configs,
    loading,
    loaded,
    unavailable,
    error,
    refresh,
    reconcile,
    setEnabled,
    update,
    remove,
    copyLocal,
    duplicate,
    busy,
  } = useHostExternalAgentConfigs()
  const localAgents = useExternalAgentStore(selectAgents)
  const [pendingDelete, setPendingDelete] = useState<ExternalAgentConfigRecord | null>(null)
  const [duplicating, setDuplicating] = useState<ExternalAgentConfigRecord | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [presetId, setPresetId] = useState<string | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  // Lineage and family, read across the host's own records (ADR-0216).
  const members = useMemo(() => configs.map(familyMember), [configs])
  const rowFacts = useMemo(() => {
    const byId = new Map<string, { sourceName: string | null; traits: InstanceTrait[] }>()
    for (const record of configs) {
      const member = familyMember(record)
      const sourceId = record.config.duplicatedFromAgentId
      const source = sourceId
        ? configs.find((other) => other.configId === sourceId || other.config.id === sourceId)
        : undefined
      byId.set(record.configId, {
        sourceName: source ? displayName(source) : null,
        traits: distinguishingTraits(member, runtimeSiblings(member, members)),
      })
    }
    return byId
  }, [configs, members])

  // Only agents the host does not already have, decided by the shared pairing
  // rule rather than by a name comparison written out here. The runtime picker
  // folds a copied agent into one row using the same rule, and the two must
  // agree about what "already there" means: when they did not, this menu
  // correctly refused to copy Pi twice while the picker listed both copies as
  // unrelated agents.
  const copyable = useMemo(
    () => pairRuntimeConfigs(Object.values(localAgents), configs).localOnly,
    [configs, localAgents]
  )
  // Two local configurations of one runtime read the same in a menu; the line
  // under each name is what tells them apart.
  const copyableTraits = useMemo(() => {
    const all = Object.values(localAgents)
    return new Map(
      copyable.map((agent) => [
        agent.id,
        traitLine(distinguishingTraits(agent, runtimeSiblings(agent, all))),
      ])
    )
  }, [copyable, localAgents, traitLine])

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 @md/agent-detail:flex-row [[data-detail-density=stacked]_&]:flex-col @md/agent-detail:items-start @md/agent-detail:justify-between">
        <div className="min-w-0">
          <h3
            tabIndex={-1}
            data-detail-heading="host"
            className="text-base font-semibold outline-none"
          >
            {title ?? t("title")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {!unavailable ? (
          <div className="flex w-full flex-col gap-2 @md/agent-detail:w-auto @md/agent-detail:shrink-0">
            <Button
              size="sm"
              disabled={busy || loading || !loaded}
              onClick={() => {
                setPresetId(null)
                setCreating(true)
              }}
            >
              <Plus className="size-4" />
              {t("newOnHost")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="w-full @md/agent-detail:w-auto [[data-detail-density=stacked]_&]:w-full"
                  variant="outline"
                  size="sm"
                  disabled={busy || loading || copyable.length === 0}
                >
                  <Upload className="size-4" />
                  {t("copyLocal")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {copyable.map((agent) => {
                  const traits = copyableTraits.get(agent.id)
                  return (
                    <DropdownMenuItem
                      key={agent.id}
                      onSelect={() => void copyLocal(agent)}
                      className="flex-col items-start gap-0"
                    >
                      <span>{agent.name}</span>
                      {traits ? (
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid={`copy-local-traits-${agent.id}`}
                        >
                          {traits}
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || loading || !loaded}
              onClick={() => void reconcile()}
            >
              <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
              {t("recheck")}
            </Button>
          </div>
        ) : null}
      </div>
      <SettingsStack>
        {unavailable ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerCog />
              </EmptyMedia>
              <EmptyTitle>{t("unavailableTitle")}</EmptyTitle>
              <EmptyDescription>{t(UNAVAILABLE_KEY[unavailable])}</EmptyDescription>
            </EmptyHeader>
            {unavailable === "no-host" ? (
              <Button
                asChild
                className="w-full @md/settings-stack:w-auto [[data-detail-density=stacked]_&]:w-full"
              >
                <Link href="/settings?section=connectivity">{t("pairHost")}</Link>
              </Button>
            ) : null}
          </Empty>
        ) : !loaded && error && !loading ? (
          <div role="alert" className="space-y-3">
            <p className="text-sm font-medium">{t("loadFailed")}</p>
            <p className="break-words text-sm text-destructive">{error}</p>
            <Button
              variant="outline"
              className="w-full @md/settings-stack:w-auto [[data-detail-density=stacked]_&]:w-full"
              onClick={() => void refresh()}
            >
              <RefreshCw className="size-4" />
              {t("retry")}
            </Button>
          </div>
        ) : !loaded || (loading && configs.length === 0) ? (
          <div
            role="status"
            aria-busy="true"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Spinner className="size-4" />
            {t("loading")}
          </div>
        ) : (
          <SettingsBlock
            title={t("count", { count: configs.length })}
            className="[&_h3]:text-[11px] [&_h3]:font-medium [&_h3]:uppercase [&_h3]:tracking-wide [&_h3]:text-muted-foreground"
            headingLevel={3}
          >
            {error ? (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {configs.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
                  <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="divide-y divide-border/60">
                {configs.map((record) => (
                  <HostConfigRow
                    key={record.configId}
                    record={record}
                    busy={busy}
                    sourceName={rowFacts.get(record.configId)?.sourceName ?? null}
                    traits={rowFacts.get(record.configId)?.traits ?? []}
                    highlighted={record.configId === highlightedId}
                    onToggle={(next) => void setEnabled(record, next)}
                    onPermissionChange={(mode) =>
                      void update(record, { defaultPermissionMode: mode })
                    }
                    onEdit={() => setEditingId(record.configId)}
                    onRemove={() => setPendingDelete(record)}
                    onDuplicate={() => setDuplicating(record)}
                  />
                ))}
              </div>
            )}
          </SettingsBlock>
        )}
      </SettingsStack>

      <Sheet
        open={editingId !== null}
        onOpenChange={(open) => {
          if (!open) setEditingId(null)
        }}
      >
        <SheetContent side="right" className="w-full gap-0 sm:max-w-lg" showCloseButton={false}>
          <SheetHeader className="flex-row items-center justify-between border-b">
            <SheetTitle>{t("editTitle")}</SheetTitle>
            <SheetDescription className="sr-only">{t("description")}</SheetDescription>
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label={tCommon("close")}
              >
                <X className="size-4" />
              </Button>
            </SheetClose>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {editingId ? (
              <HostAgentEditor
                key={editingId}
                configId={editingId}
                onRemoved={() => {
                  setEditingId(null)
                  void refresh()
                }}
                onDuplicated={(configId) => {
                  setEditingId(configId)
                  setHighlightedId(configId)
                  void refresh()
                }}
                onSaved={() => void refresh()}
                onOpenConfig={setEditingId}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-lg" showCloseButton={false}>
          <SheetHeader className="border-b">
            <div className="flex items-center justify-between gap-2">
              <SheetTitle>{t("newOnHost")}</SheetTitle>
              <SheetClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={tCommon("close")}
                >
                  <X className="size-4" />
                </Button>
              </SheetClose>
            </div>
            <SheetDescription>{t("createDescription")}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {presetId ? (
              <HostAgentCreateForm
                key={presetId}
                presetId={presetId}
                onCancel={() => setPresetId(null)}
                onCreated={(configId) => {
                  setCreating(false)
                  setHighlightedId(configId)
                  void refresh()
                }}
              />
            ) : (
              <PresetPickerList onPick={setPresetId} disabled={busy} autoFocusSearch />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {duplicating ? (
        <DuplicateAgentDialog
          // A fresh form per source: the defaults are the source's.
          key={duplicating.configId}
          open
          source={duplicateSource(duplicating)}
          existingNames={configs.map(displayName)}
          onOpenChange={(open) => {
            if (!open) setDuplicating(null)
          }}
          onDuplicate={async (options) => {
            const outcome = await duplicate(duplicating, options)
            if (outcome.ok) {
              toast.success(tManage("duplicated", { name: displayName(outcome.record) }))
              return true
            }
            // The dialog stays open; the reason is also kept in the panel.
            toast.error(tManage("duplicateFailed", { error: outcome.error }))
            return false
          }}
        />
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tManage("deleteTitle", { name: pendingDelete ? displayName(pendingDelete) : "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{tManage("deleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) void remove(pendingDelete)
                setPendingDelete(null)
              }}
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
