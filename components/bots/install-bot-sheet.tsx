"use client"

/**
 * Install a Bot: pick a definition, pick a scope, done.
 *
 * The definitions come from both worlds at once (`useBotCatalog`), because a
 * user does not think of a plugin's Bot and their own as different kinds of
 * thing, and the picker is the one place the distinction is purely
 * informational.
 *
 * Nothing here asks for configuration or credentials. An installation opens
 * `needs_setup` when a required slot is unbound, and the detail pane is where
 * both are filled in. Front-loading them into a wizard would mean a user who
 * cannot finish the wizard ends up with no installation at all, and therefore
 * nothing on screen to come back to.
 *
 * The scope choice is a per-install decision rather than a per-row one, so it
 * sits above the list and applies to whichever row is installed. Two of the
 * three `BotScopeKind` values are offered. The third is rendered and disabled
 * rather than dropped, because an absent option and an unusable one are
 * different answers and this console exists to stop collapsing those.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { PackagePlusIcon } from "lucide-react"

import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useBotCatalog } from "@/hooks/bots/use-bot-catalog"
import {
  useBotLifecycleActions,
  useBotLifecycleReadiness,
} from "@/hooks/bots/use-bot-lifecycle-actions"
import {
  catalogEntryInstallable,
  filterBotCatalog,
  type BotCatalogEntry,
} from "@/lib/bot/console/catalog"
import type { BotInstallationScope, BotScopeKind } from "@/lib/db/bot-types"
import { useProjectStore } from "@/stores/project/project-store"
import { cn } from "@/lib/utils"

import { BotExecutorIcon, BotSourceIcon } from "./bot-visuals"

/**
 * The scopes this sheet can produce.
 *
 * `project` is deliberately absent from the usable set. The kind exists for a
 * Bot bound to one project inside a workspace, and this console has no project
 * picker, so offering it would write the workspace id into the project field
 * and produce a scope that means something other than what the label says.
 */
const OFFERED_SCOPES: readonly BotScopeKind[] = ["account", "workspace", "project"]
const USABLE_SCOPES: ReadonlySet<BotScopeKind> = new Set(["account", "workspace"])

export interface InstallBotSheetProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Called with the new installation id so the console can select it. */
  onInstalled?: (installationId: string) => void
}

interface CatalogRowProps {
  entry: BotCatalogEntry
  busy: boolean
  canInstall: boolean
  onInstall: (entry: BotCatalogEntry) => void
}

function CatalogRow({ entry, busy, canInstall, onInstall }: CatalogRowProps) {
  const t = useTranslations("bots")
  const installable = catalogEntryInstallable(entry)

  return (
    <li
      className="flex items-start gap-2.5 border-b py-2.5 last:border-b-0"
      data-testid={`bot-catalog-${entry.definitionId}`}
      data-installable={installable ? "true" : "false"}
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <BotExecutorIcon executor={entry.executor} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{entry.name}</span>
          {entry.installedCount > 0 ? (
            <Badge variant="secondary" className="shrink-0 font-normal">
              {t("install.installedCount", { count: entry.installedCount })}
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-snug text-muted-foreground">
          <BotSourceIcon source={entry.source} className="size-3" />
          <span>{t(`source.${entry.source}`)}</span>
          <span aria-hidden>·</span>
          <span>{t(`executor.${entry.executor}`)}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{entry.version}</span>
        </p>
        {entry.description ? (
          <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
            {entry.description}
          </p>
        ) : null}
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {t("install.triggerCount", { count: entry.triggers.length })}
          {entry.requiredSlots.length > 0
            ? ` · ${t("install.slotCount", { count: entry.requiredSlots.length })}`
            : ""}
        </p>
        {!installable ? (
          <p
            className="mt-1 text-[11px] leading-snug text-amber-600 dark:text-amber-400"
            data-testid={`bot-catalog-blocked-${entry.definitionId}`}
          >
            {t("install.unresolvedHandler")}
          </p>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        disabled={!installable || !canInstall || busy}
        onClick={() => onInstall(entry)}
        data-testid={`bot-install-${entry.definitionId}`}
      >
        {t("install.submit")}
      </Button>
    </li>
  )
}

export function InstallBotSheet({ open, onOpenChange, onInstalled }: InstallBotSheetProps) {
  const t = useTranslations("bots")
  const { entries, loading, failed, remote } = useBotCatalog()
  const readiness = useBotLifecycleReadiness()
  const actions = useBotLifecycleActions()
  const clientWorkspaceId = useProjectStore((state) => state.activeProjectId)
  const activeWorkspaceId = remote ? null : clientWorkspaceId
  const [search, setSearch] = useState("")
  const [scopeKind, setScopeKind] = useState<BotScopeKind>("account")

  const visible = useMemo(() => filterBotCatalog(entries, search), [entries, search])

  // A workspace scope needs a workspace to scope TO. The project store
  // hydrates asynchronously, so this is "not yet" rather than "never", and the
  // option stays visible with the reason under the control.
  const scopeBlocked = scopeKind === "workspace" && !activeWorkspaceId
  const canInstall = readiness.can && !scopeBlocked

  const scope: BotInstallationScope =
    scopeKind === "workspace" && activeWorkspaceId
      ? { kind: "workspace", workspaceId: activeWorkspaceId }
      : { kind: "account" }

  const install = async (entry: BotCatalogEntry) => {
    const installationId = await actions.install({ entry, scope })
    if (!installationId) return
    onInstalled?.(installationId)
    // Closing on success is the honest end of the flow: the row now exists in
    // the list behind the sheet, and that is where setup continues.
    onOpenChange(false)
  }

  return (
    <ResponsiveDetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("install.title")}
      description={t("install.description")}
    >
      <div className="flex min-h-0 flex-col gap-3 px-4 pb-6" data-testid="install-bot-sheet">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bot-install-scope" className="text-xs">
            {t("install.scopeLabel")}
          </Label>
          <Select value={scopeKind} onValueChange={(next) => setScopeKind(next as BotScopeKind)}>
            <SelectTrigger id="bot-install-scope" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OFFERED_SCOPES.map((kind) => (
                <SelectItem key={kind} value={kind} disabled={!USABLE_SCOPES.has(kind)}>
                  {t(`scope.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p
            className={cn(
              "text-[11px] leading-snug",
              scopeBlocked ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
            )}
            data-testid="bot-install-scope-hint"
          >
            {scopeBlocked ? t("install.noWorkspace") : t(`install.scopeHint.${scopeKind}`)}
          </p>
        </div>

        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("install.searchPlaceholder")}
          aria-label={t("install.searchAria")}
          className="h-8"
          data-testid="bot-catalog-search"
        />

        {!readiness.can ? (
          <p
            className="text-[11px] leading-snug text-muted-foreground"
            data-testid="bot-install-blocked"
          >
            {t(`write.reason.${readiness.availability.reason}`)}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {failed ? (
            <p role="alert" className="text-sm text-destructive">
              {t("syncFailed")}
            </p>
          ) : loading ? (
            <div className="flex flex-col gap-1.5" data-testid="bot-catalog-loading">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : visible.length === 0 ? (
            <Empty className="border-none py-6">
              <EmptyHeader>
                <PackagePlusIcon className="size-5 text-muted-foreground" />
                <EmptyTitle className="text-sm">{t("install.emptyTitle")}</EmptyTitle>
                <EmptyDescription className="text-xs">
                  {search.trim() ? t("install.emptyFiltered") : t("install.emptyBody")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul data-testid="bot-catalog">
              {visible.map((entry) => (
                <CatalogRow
                  key={entry.definitionId}
                  entry={entry}
                  busy={actions.pending.has(`install:${entry.definitionId}`)}
                  canInstall={canInstall}
                  onInstall={install}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </ResponsiveDetailSheet>
  )
}
