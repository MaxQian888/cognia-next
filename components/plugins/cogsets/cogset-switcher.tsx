"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckIcon,
  CogIcon,
  DownloadIcon,
  HourglassIcon,
  PackageIcon,
  PlusIcon,
  SaveIcon,
  Settings2Icon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  useCogsetDisplayName,
  useCogsets,
  useInstalledPluginSummaries,
} from "@/hooks/plugins/use-cogsets"
import type { CogsetRow } from "@/types/plugin/plugin-cogset"

import { CogpackExportDialog } from "@/components/plugins/cogpacks/cogpack-export-dialog"
import { useCogpackImport } from "@/components/plugins/cogpacks/use-cogpack-import"

import { CogsetDeleteDialog } from "./cogset-delete-dialog"
import { CogsetEditorDialog, type CogsetEditorMode } from "./cogset-editor-dialog"
import { CogsetManagerDialog } from "./cogset-manager-dialog"
import { useCogsetSwitch } from "./use-cogset-switch"

/**
 * The cogset control in the Plugins toolbar (ADR-0209): which cogset runs,
 * whether that is a session override or a workspace binding, whether the last
 * switch was partial or a switch is waiting on agent runs — and the way to
 * switch, create, save and manage cogsets.
 */
export function CogsetSwitcher() {
  const t = useTranslations("plugins.cogsets.switcher")
  const view = useCogsets()
  const displayName = useCogsetDisplayName()
  const { byId } = useInstalledPluginSummaries()
  const pluginName = useCallback((pluginId: string) => byId.get(pluginId)?.name ?? pluginId, [byId])
  const switcher = useCogsetSwitch({ displayName, pluginName })
  const [editor, setEditor] = useState<CogsetEditorMode | null>(null)
  const [managerOpen, setManagerOpen] = useState(false)
  const [deleting, setDeleting] = useState<CogsetRow | null>(null)
  const [exporting, setExporting] = useState<CogsetRow | null>(null)
  const cogpackImport = useCogpackImport()

  const effective = view.effective?.cogset
  const partial = view.applied?.lastApplied?.status === "partial"
  const pendingCogset = view.state?.pending
    ? view.cogsets.find((cogset) => cogset.id === view.state?.pending?.cogsetId)
    : undefined
  const label = effective ? displayName(effective) : t("none")

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-label={t("aria", { name: label })}
            data-testid="cogset-switcher"
            disabled={view.loading}
          >
            {pendingCogset ? (
              <HourglassIcon className="mr-1.5 size-3.5" />
            ) : (
              <CogIcon className="mr-1.5 size-3.5" />
            )}
            <span className="max-w-40 truncate">
              {pendingCogset ? t("pending", { name: displayName(pendingCogset) }) : label}
            </span>
            {view.effective?.source === "session" && (
              <Badge variant="outline" className="ml-1.5">
                {t("scopeSession")}
              </Badge>
            )}
            {view.effective?.source === "workspace" && (
              <Badge variant="outline" className="ml-1.5">
                {t("scopeWorkspace")}
              </Badge>
            )}
            {partial && (
              <Badge variant="destructive" className="ml-1.5">
                {t("partial")}
              </Badge>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {pendingCogset && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="cogset-pending">
              {t("pendingDetail", { name: displayName(pendingCogset) })}
            </p>
          )}
          <DropdownMenuLabel>{t("switchTo")}</DropdownMenuLabel>
          {view.cogsets.map((cogset) => (
            <DropdownMenuItem
              key={cogset.id}
              onClick={() => {
                if (cogset.id !== view.applied?.id || cogset.id !== effective?.id)
                  switcher.request(cogset)
              }}
              className="items-start"
              data-testid={`cogset-option-${cogset.id}`}
            >
              <CheckIcon
                className={
                  effective?.id === cogset.id
                    ? "mt-0.5 mr-2 size-3.5"
                    : "mt-0.5 mr-2 size-3.5 opacity-0"
                }
              />
              <span className="flex min-w-0 flex-col">
                <span className="break-words">{displayName(cogset)}</span>
                <span className="text-xs text-muted-foreground">
                  {t("memberCount", { count: cogset.members.length })}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {!view.mirrored && (
            <>
              <DropdownMenuItem onClick={() => setEditor({ kind: "create" })}>
                <PlusIcon className="mr-2 size-3.5" />
                {t("new")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditor({ kind: "save-current" })}>
                <SaveIcon className="mr-2 size-3.5" />
                {t("saveCurrent")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem onClick={() => setManagerOpen(true)} data-testid="cogset-manage">
            <Settings2Icon className="mr-2 size-3.5" />
            {t("manage")}
          </DropdownMenuItem>
          {!view.mirrored && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={cogpackImport.pick} data-testid="cogpack-import-item">
                <DownloadIcon className="mr-2 size-3.5" />
                {t("importCogpack")}
              </DropdownMenuItem>
              {effective && (
                <DropdownMenuItem
                  onClick={() => setExporting(effective)}
                  data-testid="cogpack-export-item"
                >
                  <PackageIcon className="mr-2 size-3.5" />
                  {t("exportCogpack", { name: displayName(effective) })}
                </DropdownMenuItem>
              )}
            </>
          )}
          {view.mirrored && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("mirroredHint")}</p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {switcher.element}
      <CogsetEditorDialog
        mode={editor}
        onOpenChange={(open) => !open && setEditor(null)}
        displayName={displayName}
        alwaysOn={view.state?.alwaysOn ?? []}
      />
      <CogsetManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        view={view}
        displayName={displayName}
        pluginName={pluginName}
        isInstalled={(pluginId) => byId.has(pluginId)}
        onSwitch={switcher.request}
        onRetry={() => {
          if (view.applied) switcher.retry(displayName(view.applied))
        }}
        onCreate={() => setEditor({ kind: "create" })}
        onEdit={(cogset) => setEditor({ kind: "edit", cogset })}
        onDelete={setDeleting}
        onExport={view.mirrored ? undefined : setExporting}
      />
      <CogsetDeleteDialog
        cogset={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        displayName={displayName}
        pluginName={pluginName}
      />
      <CogpackExportDialog
        cogset={exporting}
        onOpenChange={(open) => !open && setExporting(null)}
        displayName={displayName}
        pluginName={pluginName}
      />
      {cogpackImport.element}
    </>
  )
}
