"use client"

/**
 * "Install local WASM plugin" entry button + the underlying flow hook.
 *
 * Flow:
 *   1. preview the manifest without installing so we can show the user
 *      what they're about to grant
 *   2. open the capability grant sheet (via `useWasmCapabilityGrant`)
 *   3. on confirm, finalize the install through the manager so manifest
 *      validation, descriptor projection, and Dexie wiring all happen
 *   4. on cancel, neither the installed bundle nor its grants change
 *
 * `useInstallWasmFromLocal` is exported separately so the plugin panel
 * toolbar can wire the same flow into a `DropdownMenuItem` without nesting
 * a `<Button>` inside another `<Button>`. The button below is a thin
 * wrapper around the hook, kept for standalone use (and its existing
 * test coverage).
 */

import { useCallback, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { FilePlus2Icon, Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { useWasmCapabilityGrant } from "@/hooks/plugins/use-wasm-capability-grant"
import { shortFingerprint } from "@/lib/plugin/security/signature"
import { previewLocalBundleManifest } from "@/lib/plugin/package/local-installer"

export interface InstallWasmPluginButtonProps {
  className?: string
  /** Optional callback after a successful install. */
  onInstalled?: (pluginId: string) => void
}

interface PickedPath {
  /** Absolute filesystem path of the user-picked file. */
  path: string
}

interface PickerLabels {
  title: string
  bundleFilter: string
  allFilesFilter: string
}

async function pickFile(labels: PickerLabels): Promise<PickedPath | null> {
  if (!canUseTauriInvoke()) return null
  const dialog = await import("@tauri-apps/plugin-dialog")
  const selected = await dialog.open({
    multiple: false,
    directory: false,
    title: labels.title,
    filters: [
      { name: labels.bundleFilter, extensions: ["zip"] },
      { name: labels.allFilesFilter, extensions: ["*"] },
    ],
  })
  if (typeof selected !== "string") return null
  return {
    path: selected,
  }
}

export interface UseInstallWasmFromLocal {
  trigger: () => Promise<void>
  busy: boolean
  error: string | null
  /** The grant sheet element — must be rendered exactly once in the tree. */
  sheet: ReactNode
}

export function useInstallWasmFromLocal(
  opts: { onInstalled?: (pluginId: string) => void } = {}
): UseInstallWasmFromLocal {
  const { onInstalled } = opts
  const t = useTranslations("plugins.wasmInstall.fromLocalButton")
  const grant = useWasmCapabilityGrant()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trigger = useCallback(async () => {
    setError(null)
    if (!canUseTauriInvoke()) {
      setError(t("tauriRequiredError"))
      return
    }
    try {
      setBusy(true)
      const picked = await pickFile({
        title: t("filePickerTitle"),
        bundleFilter: t("filterWasmBundle"),
        allFilesFilter: t("filterAllFiles"),
      })
      if (!picked) return // User cancelled the file picker.

      if (!picked.path.toLowerCase().endsWith(".zip")) {
        throw new Error(t("zipRequiredError"))
      }
      const preview = await previewLocalBundleManifest({ bundlePath: picked.path })
      if (!preview.bundleSha256) throw new Error(t("previewIntegrityError"))
      const authorFingerprint =
        preview.signatureVerified && preview.authorFingerprint
          ? shortFingerprint(preview.authorFingerprint)
          : undefined

      const decision = await grant.requestGrant({
        manifest: preview.manifest,
        authorFingerprint,
        persist: false,
      })
      if (!decision) {
        // Cancelled grant — abort before any disk write.
        return
      }

      const manager = getPluginManager()
      const plugin = await manager.installWasmPluginFromLocalFile(picked.path, decision.decision, {
        expectedBundleSha256: preview.bundleSha256,
      })
      onInstalled?.(plugin.manifest.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [grant, onInstalled, t])

  return { trigger, busy, error, sheet: grant.sheet }
}

export function InstallWasmPluginButton({ className, onInstalled }: InstallWasmPluginButtonProps) {
  const t = useTranslations("plugins.wasmInstall.fromLocalButton")
  const { trigger, busy, error, sheet } = useInstallWasmFromLocal({ onInstalled })

  return (
    <>
      <Button
        onClick={() => void trigger()}
        disabled={busy}
        className={className}
        data-testid="install-wasm-plugin-button"
      >
        {busy ? (
          <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden />
        ) : (
          <FilePlus2Icon className="mr-2 size-4" aria-hidden />
        )}
        {t("label")}
      </Button>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {sheet}
    </>
  )
}
