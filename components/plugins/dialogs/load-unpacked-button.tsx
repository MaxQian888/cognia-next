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
import {
  inspectLocalPluginSource,
  type LocalPluginInspection,
} from "@/lib/plugin/local/convert-local-source"
import { PluginPreInstallDialog } from "./plugin-pre-install-dialog"
import { LoadUnpackedConversionDialog } from "./load-unpacked-conversion-dialog"

export interface LoadUnpackedButtonProps {
  className?: string
  /** Called with the resolved plugin id after a successful install. */
  onInstalled?: (pluginId: string) => void
}

interface UseLoadUnpackedFlow {
  trigger: (sourceDir?: string) => Promise<void>
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
  const [pending, setPending] = useState<{
    sourceDir: string
    inspection: LocalPluginInspection
  } | null>(null)
  const preInstall = usePluginPreInstall(null)

  /**
   * Run the shared pre-install chain against a directory, optionally with a
   * conversion overlay. Split out because a foreign bundle takes the same path
   * as a native one, just after the user approves the conversion.
   */
  const runInstall = useCallback(
    async (sourceDir: string, inspection: LocalPluginInspection) => {
      const manifest = inspection.manifest
      if (!manifest) throw new Error("conversion produced no manifest")
      const pluginId = manifest.id
      const pluginName = manifest.name ?? pluginId
      const client = createLocalDirectoryClient(
        sourceDir,
        inspection.native ? undefined : { manifest, generatedFiles: inspection.generatedFiles }
      )
      const result = await preInstall.install(pluginId, manifest.version, pluginName, client)
      if (result.status === "installed") {
        toast.success(t("installSuccess", { name: pluginName }))
        onInstalled?.(result.pluginId)
      } else if (result.status === "cancelled") {
        // Quiet — the user explicitly backed out at a step.
      } else {
        setError(result.message)
      }
    },
    [onInstalled, preInstall, t]
  )

  const trigger = useCallback(
    async (providedSourceDir?: string) => {
      setError(null)
      if (!canUseTauriInvoke()) {
        setError(t("tauriRequiredError"))
        return
      }
      try {
        setBusy(true)
        const picked = providedSourceDir
          ? providedSourceDir
          : await import("@tauri-apps/plugin-dialog").then((dialog) =>
              dialog.open({
                directory: true,
                multiple: false,
                title: t("directoryPickerTitle"),
              })
            )
        if (typeof picked !== "string") return // user cancelled

        // Reads the whole bundle, not just `plugin.json`, so a Claude Code /
        // Codex / Gemini directory is recognised instead of throwing a raw
        // "plugin.json not found" at the user. The manifest that comes back is
        // the converted one, which is what the pre-install chain must gate on.
        const inspection = await inspectLocalPluginSource(picked)
        if (inspection.native) {
          await runInstall(picked, inspection)
          return
        }
        // Foreign bundle: the user sees what conversion carries over first.
        setPending({ sourceDir: picked, inspection })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [runInstall, t]
  )

  const confirmConversion = useCallback(async () => {
    if (!pending) return
    const { sourceDir, inspection } = pending
    setPending(null)
    setBusy(true)
    try {
      await runInstall(sourceDir, inspection)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [pending, runInstall])

  const dialog = (
    <>
      <LoadUnpackedConversionDialog
        inspection={pending?.inspection ?? null}
        onConfirm={() => void confirmConversion()}
        onCancel={() => setPending(null)}
        busy={busy}
      />
      <PluginPreInstallDialog
        target={preInstall.target}
        onContinue={preInstall.resolveContinue}
        onCancel={preInstall.resolveCancel}
      />
    </>
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
