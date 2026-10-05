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
import { useTranslations } from "next-intl"
import { CopyPlus, RefreshCw, ServerCog, Trash2, Upload } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"
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
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
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
  onToggle,
  onRemove,
  onDuplicate,
}: {
  record: ExternalAgentConfigRecord
  busy: boolean
  /** The configuration this one was duplicated from, when it still exists. */
  sourceName: string | null
  /** What sets it apart from the host's other configurations of its runtime. */
  traits: readonly InstanceTrait[]
  onToggle: (next: boolean) => void
  onRemove: () => void
  onDuplicate: () => void
}) {
  const t = useTranslations("externalAgent.hostConfigs")
  const tManage = useTranslations("externalAgentManage.hostConfigs")
  // No cast: `record.config` is a `StoredExternalAgentConfig`, which already
  // types `name`, `protocol` and the lifecycle fields read below.
  const config = record.config
  const name = displayName(record)
  const notReady = record.lifecycleStatus !== "ready"

  return (
    <Item variant="outline" data-testid={`host-config-${record.configId}`}>
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
      <ItemActions className="gap-1">
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
          size="icon"
          className="touch-hit"
          disabled={busy}
          onClick={onDuplicate}
          aria-label={tManage("duplicateLabel", { name })}
        >
          <CopyPlus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="touch-hit"
          disabled={busy}
          onClick={onRemove}
          aria-label={t("deleteLabel", { name })}
        >
          <Trash2 className="size-4" />
        </Button>
      </ItemActions>
    </Item>
  )
}

export function HostExternalAgentConfigs() {
  const t = useTranslations("externalAgent.hostConfigs")
  const tManage = useTranslations("externalAgentManage.hostConfigs")
  const tCommon = useTranslations("common")
  const traitLine = useInstanceTraitLine()
  const {
    configs,
    loading,
    unavailable,
    error,
    reconcile,
    setEnabled,
    remove,
    copyLocal,
    duplicate,
    busy,
  } = useHostExternalAgentConfigs()
  const localAgents = useExternalAgentStore(selectAgents)
  const [pendingDelete, setPendingDelete] = useState<ExternalAgentConfigRecord | null>(null)
  const [duplicating, setDuplicating] = useState<ExternalAgentConfigRecord | null>(null)

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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ServerCog className="size-4" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {unavailable ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerCog />
              </EmptyMedia>
              <EmptyTitle>{t("unavailableTitle")}</EmptyTitle>
              <EmptyDescription>{t(UNAVAILABLE_KEY[unavailable])}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner className="size-4" />
            {t("loading")}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground text-sm">
                {t("count", { count: configs.length })}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {/* Disabled rather than hidden when there is nothing to copy:
                    the empty state names this action, and a control that
                    vanishes makes the sentence look like a lie. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={busy || copyable.length === 0}>
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
                  disabled={busy}
                  onClick={() => void reconcile()}
                >
                  <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
                  {t("recheck")}
                </Button>
              </div>
            </div>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            {configs.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
                  <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-2">
                {configs.map((record) => (
                  <HostConfigRow
                    key={record.configId}
                    record={record}
                    busy={busy}
                    sourceName={rowFacts.get(record.configId)?.sourceName ?? null}
                    traits={rowFacts.get(record.configId)?.traits ?? []}
                    onToggle={(next) => void setEnabled(record, next)}
                    onRemove={() => setPendingDelete(record)}
                    onDuplicate={() => setDuplicating(record)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>

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
    </Card>
  )
}
