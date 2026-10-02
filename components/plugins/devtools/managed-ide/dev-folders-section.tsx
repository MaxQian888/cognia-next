"use client"

/**
 * Managed IDE Dev Mode plugin folders: register a folder, install the plugin
 * in it through the usual Load unpacked review (the host trusts it for this
 * session with a `local-dev` receipt), and see its `manifest.ide` problems
 * live. Diagnostics re-run whenever a file under the folder changes (while
 * Watch plugin folders is on) or on request.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderPlusIcon, RefreshCwIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useLoadUnpackedFlow } from "@/components/plugins/dialogs/load-unpacked-button"
import { FILE_CHANGE_EVENT, type PluginFileChangePayload } from "@/lib/plugin/devtools/file-watch"
import { registerDevFolder, unregisterDevPath } from "@/lib/plugin/ide/dev-mode"
import {
  diagnoseDevFolderManifest,
  type DevFolderDiagnosis,
} from "@/lib/plugin/ide/dev-folder-diagnostics"
import { previewLocalManifest } from "@/lib/plugin/local/install-from-directory"
import { onTauriEvent } from "@/lib/tauri/events"

type FolderCheck = { diagnosis: DevFolderDiagnosis } | { unreadable: string }

export interface DevFoldersSectionProps {
  folders: Array<{ path: string; pluginId: string }>
}

async function check(path: string): Promise<FolderCheck> {
  try {
    return { diagnosis: diagnoseDevFolderManifest(await previewLocalManifest(path)) }
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) }
  }
}

function isUnder(changed: string, root: string): boolean {
  return changed === root || changed.startsWith(`${root}/`) || changed.startsWith(`${root}\\`)
}

export function DevFoldersSection({ folders }: DevFoldersSectionProps) {
  const t = useTranslations("plugins.devtools.managedIde.folders")
  const [checks, setChecks] = useState<Record<string, FolderCheck>>({})
  const [addError, setAddError] = useState<string | null>(null)
  const loadUnpacked = useLoadUnpackedFlow()

  const recheck = useCallback(async (path: string) => {
    const result = await check(path)
    setChecks((current) => ({ ...current, [path]: result }))
  }, [])

  // Stable across renders that do not change the folder set.
  const folderKey = folders.map((folder) => folder.path).join("\0")
  const paths = useMemo(() => (folderKey ? folderKey.split("\0") : []), [folderKey])
  useEffect(() => {
    let active = true
    void Promise.all(paths.map(async (path) => [path, await check(path)] as const)).then(
      (results) => {
        if (active) setChecks((current) => ({ ...current, ...Object.fromEntries(results) }))
      }
    )
    return () => {
      active = false
    }
  }, [paths])

  useEffect(() => {
    if (paths.length === 0) return
    let unlisten: (() => void) | undefined
    let active = true
    void onTauriEvent<PluginFileChangePayload>(FILE_CHANGE_EVENT, (payload) => {
      for (const path of paths) {
        if (isUnder(payload.path, path)) void recheck(path)
      }
    })
      .then((off) => {
        if (active) unlisten = off
        else off()
      })
      .catch(() => undefined)
    return () => {
      active = false
      unlisten?.()
    }
  }, [paths, recheck])

  const add = useCallback(async () => {
    setAddError(null)
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({ directory: true, multiple: false, title: t("pickerTitle") })
      if (typeof picked !== "string") return
      const manifest = await previewLocalManifest(picked)
      // Registered first, so the install that follows earns a local-dev receipt.
      await registerDevFolder(picked, manifest.id)
      await loadUnpacked.trigger(picked)
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error))
    }
  }, [loadUnpacked, t])

  return (
    <div className="space-y-3" data-testid="managed-ide-folders">
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1.5"
        onClick={() => void add()}
        disabled={loadUnpacked.busy}
      >
        <FolderPlusIcon className="size-3.5" aria-hidden="true" />
        {t("add")}
      </Button>
      {(addError ?? loadUnpacked.error) && (
        <p className="text-xs text-destructive" data-testid="managed-ide-folders-error">
          {t("addFailed", { message: addError ?? loadUnpacked.error ?? "" })}
        </p>
      )}
      {folders.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {folders.map((folder) => {
            const result = checks[folder.path]
            return (
              <li
                key={folder.path}
                className="space-y-1.5 rounded-md border px-2.5 py-2 text-xs"
                data-testid={`managed-ide-folder-${folder.pluginId}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{folder.pluginId}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                    {folder.path}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={t("recheck")}
                    onClick={() => void recheck(folder.path)}
                  >
                    <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={t("remove", { path: folder.path })}
                    onClick={() => void unregisterDevPath(folder.path)}
                  >
                    <XIcon className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                {result && "unreadable" in result ? (
                  <p className="text-destructive">
                    {t("unreadable", { message: result.unreadable })}
                  </p>
                ) : result ? (
                  <FolderDiagnosis diagnosis={result.diagnosis} />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {loadUnpacked.dialog}
    </div>
  )
}

function FolderDiagnosis({ diagnosis }: { diagnosis: DevFolderDiagnosis }) {
  const t = useTranslations("plugins.devtools.managedIde.folders")
  if (!diagnosis.managedIde) return <p className="text-muted-foreground">{t("noIde")}</p>
  return (
    <div className="space-y-1">
      {diagnosis.diagnostics.length === 0 ? (
        <Badge variant="outline" className="text-[10px]">
          {t("valid")}
        </Badge>
      ) : (
        <>
          <Badge variant="destructive" className="text-[10px]">
            {t("problems", { count: diagnosis.diagnostics.length })}
          </Badge>
          <ul className="space-y-0.5 font-mono text-[11px] text-destructive">
            {diagnosis.diagnostics.map((entry, index) => (
              <li key={`${entry.code}-${index}`}>
                {entry.code}
                {entry.field ? ` ${entry.field}` : ""}: {entry.message}
              </li>
            ))}
          </ul>
        </>
      )}
      {diagnosis.warnings.length > 0 && (
        <p className="text-muted-foreground">
          {t("warnings")}: {diagnosis.warnings.join(", ")}
        </p>
      )}
    </div>
  )
}
