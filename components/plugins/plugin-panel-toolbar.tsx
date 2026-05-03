"use client"

// Toolbar with primary actions for the /plugins panel: install from file,
// install from URL, check for updates, and sync the marketplace registry.
// File install stages parsed JSON manifests through
// `usePluginsStore.setImportStaging`; URL install delegates to a proper
// modal dialog instead of `window.prompt`.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  DownloadIcon,
  PlusIcon,
  RefreshCcwIcon,
  UploadIcon,
  GlobeIcon,
  Loader2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePluginsStore } from "@/stores/plugins"
import { PluginInstallFromUrlDialog } from "./plugin-install-from-url-dialog"

interface Props {
  /** Opens the update dialog (mounted by the parent panel). */
  onCheckUpdates?: () => void
  /** Refreshes the marketplace registry + checks every installed plugin
   *  against the catalog. Wired by the panel; when omitted the button is
   *  rendered as disabled so the surface still demonstrates the affordance. */
  onSyncRegistry?: () => Promise<void> | void
  /** Set by the parent while a sync is in flight to drive the spinner. */
  syncing?: boolean
}

export function PluginPanelToolbar({ onCheckUpdates, onSyncRegistry, syncing = false }: Props) {
  const t = useTranslations("plugins.toolbar")
  const setImportStaging = usePluginsStore((s) => s.setImportStaging)
  const [busy, setBusy] = useState(false)
  const [urlDialogOpen, setUrlDialogOpen] = useState(false)

  const handleInstallFromFile = async () => {
    setBusy(true)
    try {
      const input = document.createElement("input")
      input.type = "file"
      // Only JSON manifests are supported by the current parser. The plugin
      // package layer doesn't ship an archive reader yet, so accepting
      // .tar.gz / .zip would just yield silent parse failures.
      input.accept = ".json,application/json"
      input.multiple = true
      const files = await new Promise<File[]>((resolve) => {
        input.onchange = () => resolve(Array.from(input.files ?? []))
        input.oncancel = () => resolve([])
        input.click()
      })
      if (files.length === 0) return

      const drafts: Array<{
        id: string
        name: string
        version: string
        manifest: Record<string, unknown>
        sourceLabel: string
      }> = []
      const parseErrors: { name: string; error: string }[] = []
      for (const file of files) {
        try {
          const text = await file.text()
          const manifest = JSON.parse(text) as Record<string, unknown>
          drafts.push({
            id: String(manifest.id ?? file.name),
            name: String(manifest.name ?? file.name),
            version: String(manifest.version ?? "0.0.0"),
            manifest,
            sourceLabel: file.name,
          })
        } catch (err) {
          parseErrors.push({
            name: file.name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      setImportStaging({
        drafts,
        sourceLabel: t("fromFileSourceLabel", { count: files.length }),
        parseErrors,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" disabled={busy}>
              <PlusIcon className="size-3.5 mr-1.5" />
              {t("install")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void handleInstallFromFile()}>
              <UploadIcon className="size-3.5 mr-2" />
              {t("fromFile")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setUrlDialogOpen(true)}>
              <GlobeIcon className="size-3.5 mr-2" />
              {t("fromUrl")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="outline" onClick={onCheckUpdates}>
          <RefreshCcwIcon className="size-3.5 mr-1.5" />
          {t("checkUpdates")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void onSyncRegistry?.()}
          disabled={syncing || !onSyncRegistry}
          aria-label={t("syncRegistryAria")}
        >
          {syncing ? (
            <Loader2Icon className="size-3.5 mr-1.5 animate-spin" />
          ) : (
            <DownloadIcon className="size-3.5 mr-1.5" />
          )}
          {t("syncRegistry")}
        </Button>
      </div>

      <PluginInstallFromUrlDialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen} />
    </>
  )
}
