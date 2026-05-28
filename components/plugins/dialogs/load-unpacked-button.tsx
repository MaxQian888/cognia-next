"use client"

/**
 * "Load unpacked" entry button — Chrome-extension-style local plugin
 * sideload. Opens a directory picker, runs the same pre-install chain
 * the marketplace uses (conflict → permission → config dialogs), and
 * finalizes the install through `plugin_install_from_directory`.
 *
 * Distinct from `InstallWasmPluginButton`, which targets a single
 * `.wasm` / `.zip` file and includes the WASM capability-grant sheet.
 * The two coexist in the toolbar so plugin authors can pick the
 * shape that matches the bundle they're iterating on.
 */

import { useCallback, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon, Loader2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { usePluginPreInstall } from "@/hooks/plugins/use-plugin-pre-install"
import { createLocalDirectoryClient } from "@/lib/plugin/local/local-directory-client"
import { previewLocalManifest } from "@/lib/plugin/local/install-from-directory"
import { PluginPreInstallDialog } from "./plugin-pre-install-dialog"

export interface LoadUnpackedButtonProps {
  className?: string
  /** Called with the resolved plugin id after a successful install. */
  onInstalled?: (pluginId: string) => void
}

interface UseLoadUnpackedFlow {
  trigger: () => Promise<void>
  busy: boolean
  error: string | null
  /** Pre-install dialog element — must be rendered exactly once below. */
  dialog: ReactNode
}

/**
 * Hook surface — separated so the toolbar can wire the same flow into a
 * dropdown menu item without nesting the trigger button.
 */
export function useLoadUnpackedFlow(
  opts: { onInstalled?: (pluginId: string) => void } = {}
): UseLoadUnpackedFlow {
  const { onInstalled } = opts
  const t = useTranslations("plugins.loadUnpacked")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceDir, setSourceDir] = useState<string | null>(null)
  // The pre-install client is bound to a source directory; we recreate it
  // on every trigger so re-picking a different folder doesn't carry stale
  // manifest cache.
  const client = sourceDir ? createLocalDirectoryClient(sourceDir) : null
  const preInstall = usePluginPreInstall(client)

  const trigger = useCallback(async () => {
    setError(null)
    if (!canUseTauriInvoke()) {
      setError(t("tauriRequiredError"))
      return
    }
    try {
      setBusy(true)
      const dialog = await import("@tauri-apps/plugin-dialog")
      const picked = await dialog.open({
        directory: true,
        multiple: false,
        title: t("directoryPickerTitle"),
      })
      if (typeof picked !== "string") return // user cancelled
      setSourceDir(picked)
      // Resolve the real plugin id from disk so the pre-install chain
      // gets a meaningful id (used for conflict detection against the
      // installed-plugins table).
      const manifest = await previewLocalManifest(picked)
      const pluginId = manifest.id
      const pluginName = manifest.name ?? pluginId

      // Rebuild the client now that we have a sourceDir to bind to. The
      // useMemo inside usePluginPreInstall takes the new client when the
      // state flips on the next render — but `install()` only resolves
      // after we await, by which time React has re-rendered with the
      // bound client. Defer to a microtask so the state flush settles.
      await Promise.resolve()

      const result = await preInstall.install(pluginId, manifest.version, pluginName)
      if (result.status === "installed") {
        toast.success(t("installSuccess", { name: pluginName }))
        onInstalled?.(result.pluginId)
      } else if (result.status === "cancelled") {
        // Quiet — the user explicitly backed out at a step.
      } else {
        setError(result.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setSourceDir(null)
    }
  }, [onInstalled, preInstall, t])

  const dialog = (
    <PluginPreInstallDialog
      target={preInstall.target}
      onContinue={preInstall.resolveContinue}
      onCancel={preInstall.resolveCancel}
    />
  )

  return { trigger, busy, error, dialog }
}

export function LoadUnpackedButton({ className, onInstalled }: LoadUnpackedButtonProps) {
  const t = useTranslations("plugins.loadUnpacked")
  const { trigger, busy, error, dialog } = useLoadUnpackedFlow({ onInstalled })

  return (
    <>
      <Button
        variant="outline"
        onClick={() => void trigger()}
        disabled={busy}
        className={className}
        data-testid="load-unpacked-button"
      >
        {busy ? (
          <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden="true" />
        ) : (
          <FolderOpenIcon className="mr-2 size-4" aria-hidden="true" />
        )}
        {t("label")}
      </Button>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {dialog}
    </>
  )
}
