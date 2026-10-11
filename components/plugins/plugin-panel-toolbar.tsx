"use client"

// Toolbar with primary actions for the /plugins panel: install from file,
// install from URL, check for updates, and sync the marketplace registry.
// File install stages parsed JSON manifests through
// `usePluginsStore.setImportStaging`; URL install delegates to a proper
// modal dialog instead of `window.prompt`.
//
// Two install lanes are exposed via grouped dropdown items:
//   • Manifest (web + desktop) — JSON manifest file / URL, staged for review
//   • Git / local / WASM (desktop only) — these read a disk path or a git
//     checkout and run in the Rust backend
//
// Layout: one primary action (Install, a menu of every install lane, plus
// "Convert plugin…" since converting is how a plugin from another ecosystem
// gets installed), the cogset switcher, Check for updates, and an overflow
// menu for the rarely used registry sync. These used to be five equal-weight
// buttons in a row, with Convert and Sync competing with Install for the eye.
// `layout="compact"` (the phone) keeps Install and the cogset visible and
// folds Check for updates into the overflow menu too.
//
// The desktop-only lanes are RENDERED EVERYWHERE and disabled off the desktop
// shell, not hidden. Hiding them collapsed three different answers into one
// blank menu: "this does not exist", "this exists and needs the desktop app",
// and "this is broken". A user on the web build had no way to tell which, and
// no reason to look for the desktop app.

import { useState } from "react"
import dynamic from "next/dynamic"
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
  ArrowRightLeftIcon,
  MoreHorizontalIcon,
  PackageIcon,
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
import { cn } from "@/lib/utils"
import { usePluginsStore } from "@/stores/plugins"
import { PluginInstallFromUrlDialog } from "./dialogs/plugin-install-from-url-dialog"
import { PluginInstallFromGithubDialog } from "./dialogs/plugin-install-from-github-dialog"
import { PluginSignedInstallFromUrlDialog } from "./dialogs/plugin-signed-install-from-url-dialog"
import { PluginWasmFromGitDialog } from "./dialogs/plugin-wasm-from-git-dialog"
import { useInstallWasmFromLocal } from "./dialogs/install-wasm-plugin-button"
import { useLoadUnpackedFlow } from "./dialogs/load-unpacked-button"
import { PluginConversionDialog } from "./dialogs/plugin-conversion-dialog"
import { CliStatusChip } from "./cli-status-chip"
import { CogsetSwitcher } from "./cogsets/cogset-switcher"
import { useCogpackImport } from "./cogpacks/use-cogpack-import"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"

const PluginVsixInstallDialog = dynamic(
  () => import("./dialogs/plugin-vsix-install-dialog").then((mod) => mod.PluginVsixInstallDialog),
  { ssr: false }
)

interface Props {
  /** Opens the update dialog (mounted by the parent panel). */
  onCheckUpdates?: () => void
  /** Refreshes the marketplace registry + checks every installed plugin
   *  against the catalog. Wired by the panel; when omitted the button is
   *  rendered as disabled so the surface still demonstrates the affordance. */
  onSyncRegistry?: () => Promise<void> | void
  /** Set by the parent while a sync is in flight to drive the spinner. */
  syncing?: boolean
  /**
   * `"row"` (default): the desktop header. `"compact"`: the phone, where only
   * Install and the cogset stay on the bar and everything else is in the
   * overflow menu.
   */
  layout?: "row" | "compact"
}

function DesktopOnlyChip({ label }: { label: string }) {
  return (
    <span className="rounded-pill border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
      {label}
    </span>
  )
}

export function PluginPanelToolbar({
  onCheckUpdates,
  onSyncRegistry,
  syncing = false,
  layout = "row",
}: Props) {
  const compact = layout === "compact"
  const t = useTranslations("plugins.toolbar")
  const setImportStaging = usePluginsStore((s) => s.setImportStaging)
  const [conversionOpen, setConversionOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [urlDialogOpen, setUrlDialogOpen] = useState(false)
  const [githubDialogOpen, setGithubDialogOpen] = useState(false)
  const [signedUrlDialogOpen, setSignedUrlDialogOpen] = useState(false)
  const [vsixDialogOpen, setVsixDialogOpen] = useState(false)
  const [wasmGitDialogOpen, setWasmGitDialogOpen] = useState(false)
  const cogpackImport = useCogpackImport()
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
      <div
        className={cn("flex items-center gap-2", compact ? "flex-nowrap" : "flex-wrap")}
        data-layout={layout}
        data-testid="plugin-panel-toolbar"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              disabled={busy || wasmLocal.busy}
              className="pointer-coarse:h-10"
              data-testid="plugin-install-trigger"
            >
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
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("groupCogpack")}</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={cogpackImport.pick}
              disabled={isMirroredPluginClient()}
              data-testid="plugin-install-from-cogpack"
            >
              <PackageIcon className="size-3.5 mr-2" />
              {t("fromCogpack")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center justify-between gap-2">
              {t("groupGit")}
              {!wasmAvailable && <DesktopOnlyChip label={t("desktopOnlyHint")} />}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => setGithubDialogOpen(true)}
              disabled={!wasmAvailable}
              data-testid="plugin-install-from-github"
            >
              <GitBranchIcon className="size-3.5 mr-2" />
              {t("fromGithub")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("groupLocal")}</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => void loadUnpacked.trigger()}
              disabled={!wasmAvailable || loadUnpacked.busy}
              data-testid="plugin-install-load-unpacked"
            >
              <FolderOpenIcon className="size-3.5 mr-2" />
              {t("loadUnpacked")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setVsixDialogOpen(true)}
              disabled={!wasmAvailable}
              data-testid="plugin-install-from-vsix"
            >
              <FileArchiveIcon className="size-3.5 mr-2" />
              {t("fromVsix")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("groupWasm")}</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => void wasmLocal.trigger()}
              disabled={!wasmAvailable || wasmLocal.busy}
              data-testid="plugin-install-from-local-wasm"
            >
              <FilePlus2Icon className="size-3.5 mr-2" />
              {t("fromLocalWasm")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setSignedUrlDialogOpen(true)}
              disabled={!wasmAvailable}
              data-testid="plugin-install-from-signed-url"
            >
              <ShieldCheckIcon className="size-3.5 mr-2" />
              {t("fromUrlSigned")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setWasmGitDialogOpen(true)}
              disabled={!wasmAvailable}
              data-testid="plugin-install-from-wasm-git"
            >
              <GitMergeIcon className="size-3.5 mr-2" />
              {t("fromWasmGit")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center justify-between gap-2">
              {t("groupConvert")}
              {!wasmAvailable && <DesktopOnlyChip label={t("desktopOnlyHint")} />}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => setConversionOpen(true)}
              disabled={!wasmAvailable}
              data-testid="plugin-install-convert"
            >
              <ArrowRightLeftIcon className="size-3.5 mr-2" />
              {t("convertPlugin")}
            </DropdownMenuItem>
            {!wasmAvailable && (
              <p
                className="px-2 py-1.5 text-xs text-muted-foreground"
                data-testid="plugin-install-desktop-only-hint"
              >
                {t("desktopOnlyGroupHint")}
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <CogsetSwitcher />
        {compact ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={onCheckUpdates}
            aria-label={t("checkUpdates")}
            data-testid="plugin-check-updates"
          >
            <RefreshCcwIcon className="size-3.5 @3xl/feature-header:mr-1.5" />
            <span className="hidden @3xl/feature-header:inline">{t("checkUpdates")}</span>
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 pointer-coarse:size-10"
              aria-label={t("moreActions")}
              data-testid="plugin-toolbar-more"
            >
              {syncing ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <MoreHorizontalIcon className="size-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {compact ? (
              <DropdownMenuItem onClick={onCheckUpdates} data-testid="plugin-check-updates">
                <RefreshCcwIcon className="size-3.5 mr-2" />
                {t("checkUpdates")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => void onSyncRegistry?.()}
              disabled={syncing || !onSyncRegistry}
              className="items-start"
              data-testid="plugin-sync-registry"
            >
              {syncing ? (
                <Loader2Icon className="mt-0.5 size-3.5 mr-2 shrink-0 animate-spin" />
              ) : (
                <DownloadIcon className="mt-0.5 size-3.5 mr-2 shrink-0" />
              )}
              <span className="flex min-w-0 flex-col">
                <span>{syncing ? t("syncing") : t("syncRegistry")}</span>
                <span className="text-[11px] leading-snug whitespace-normal text-muted-foreground">
                  {t("syncRegistryHint")}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {compact ? null : (
          <div className="ml-auto">
            <CliStatusChip />
          </div>
        )}
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

      {wasmAvailable && (
        <PluginConversionDialog open={conversionOpen} onOpenChange={setConversionOpen} />
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
      {wasmAvailable && vsixDialogOpen && (
        <PluginVsixInstallDialog open={vsixDialogOpen} onOpenChange={setVsixDialogOpen} />
      )}
      {wasmAvailable && (
        <PluginWasmFromGitDialog open={wasmGitDialogOpen} onOpenChange={setWasmGitDialogOpen} />
      )}
      {cogpackImport.element}
      {wasmLocal.sheet}
      {loadUnpacked.dialog}
    </>
  )
}
