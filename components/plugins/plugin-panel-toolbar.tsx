"use client"

// Toolbar with primary actions for the /plugins panel: install from file,
// install from URL, check for updates, and sync the marketplace registry.
// File install stages parsed JSON manifests through
// `usePluginsStore.setImportStaging`; URL install delegates to a proper
// modal dialog instead of `window.prompt`.
//
// Two install lanes are exposed via grouped dropdown items:
//   • Manifest (web + desktop) — JSON manifest file / URL, staged for review
//   • WASM bundle (Tauri only) — local .wasm/.zip or signed URL with grant sheet

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  DownloadIcon,
  PlusIcon,
  RefreshCcwIcon,
  UploadIcon,
  GlobeIcon,
  Loader2Icon,
  FilePlus2Icon,
  ShieldCheckIcon,
  FolderOpenIcon,
  GitBranchIcon,
  FileArchiveIcon,
  GitMergeIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { usePluginsStore } from "@/stores/plugins"
import { PluginInstallFromUrlDialog } from "./dialogs/plugin-install-from-url-dialog"
import { PluginInstallFromGithubDialog } from "./dialogs/plugin-install-from-github-dialog"
import { PluginSignedInstallFromUrlDialog } from "./dialogs/plugin-signed-install-from-url-dialog"
import { PluginVsixInstallDialog } from "./dialogs/plugin-vsix-install-dialog"
import { PluginWasmFromGitDialog } from "./dialogs/plugin-wasm-from-git-dialog"
import { useInstallWasmFromLocal } from "./dialogs/install-wasm-plugin-button"
import { useLoadUnpackedFlow } from "./dialogs/load-unpacked-button"
import { CliStatusChip } from "./cli-status-chip"

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
  const [githubDialogOpen, setGithubDialogOpen] = useState(false)
  const [signedUrlDialogOpen, setSignedUrlDialogOpen] = useState(false)
  const [vsixDialogOpen, setVsixDialogOpen] = useState(false)
  const [wasmGitDialogOpen, setWasmGitDialogOpen] = useState(false)
  const wasmLocal = useInstallWasmFromLocal()
  const loadUnpacked = useLoadUnpackedFlow()
  const wasmAvailable = canUseTauriInvoke()

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
            <Button size="sm" disabled={busy || wasmLocal.busy}>
              <PlusIcon className="size-3.5 mr-1.5" />
              {t("install")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t("groupManifest")}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => void handleInstallFromFile()}>
              <UploadIcon className="size-3.5 mr-2" />
              {t("fromFile")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setUrlDialogOpen(true)}>
              <GlobeIcon className="size-3.5 mr-2" />
              {t("fromUrl")}
            </DropdownMenuItem>
            {wasmAvailable && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("groupGit")}</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setGithubDialogOpen(true)}>
                  <GitBranchIcon className="size-3.5 mr-2" />
                  {t("fromGithub")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("groupLocal")}</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => void loadUnpacked.trigger()}
                  disabled={loadUnpacked.busy}
                >
                  <FolderOpenIcon className="size-3.5 mr-2" />
                  {t("loadUnpacked")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setVsixDialogOpen(true)}>
                  <FileArchiveIcon className="size-3.5 mr-2" />
                  {t("fromVsix")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("groupWasm")}</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => void wasmLocal.trigger()}
                  disabled={wasmLocal.busy}
                >
                  <FilePlus2Icon className="size-3.5 mr-2" />
                  {t("fromLocalWasm")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSignedUrlDialogOpen(true)}>
                  <ShieldCheckIcon className="size-3.5 mr-2" />
                  {t("fromUrlSigned")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setWasmGitDialogOpen(true)}>
                  <GitMergeIcon className="size-3.5 mr-2" />
                  {t("fromWasmGit")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="outline" onClick={onCheckUpdates} aria-label={t("checkUpdates")}>
          <RefreshCcwIcon className="size-3.5 lg:mr-1.5" />
          <span className="hidden lg:inline">{t("checkUpdates")}</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void onSyncRegistry?.()}
          disabled={syncing || !onSyncRegistry}
          aria-label={t("syncRegistryAria")}
        >
          {syncing ? (
            <Loader2Icon className="size-3.5 lg:mr-1.5 animate-spin" />
          ) : (
            <DownloadIcon className="size-3.5 lg:mr-1.5" />
          )}
          <span className="hidden lg:inline">{t("syncRegistry")}</span>
        </Button>
        <div className="ml-auto">
          <CliStatusChip />
        </div>
      </div>

      {wasmLocal.error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {wasmLocal.error}
        </p>
      )}
      {loadUnpacked.error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {loadUnpacked.error}
        </p>
      )}

      <PluginInstallFromUrlDialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen} />
      {wasmAvailable && (
        <PluginInstallFromGithubDialog open={githubDialogOpen} onOpenChange={setGithubDialogOpen} />
      )}
      {wasmAvailable && (
        <PluginSignedInstallFromUrlDialog
          open={signedUrlDialogOpen}
          onOpenChange={setSignedUrlDialogOpen}
        />
      )}
      {wasmAvailable && (
        <PluginVsixInstallDialog open={vsixDialogOpen} onOpenChange={setVsixDialogOpen} />
      )}
      {wasmAvailable && (
        <PluginWasmFromGitDialog open={wasmGitDialogOpen} onOpenChange={setWasmGitDialogOpen} />
      )}
      {wasmLocal.sheet}
      {loadUnpacked.dialog}
    </>
  )
}
