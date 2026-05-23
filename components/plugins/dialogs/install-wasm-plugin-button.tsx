"use client"

/**
 * "Install local WASM plugin" entry button + the underlying flow hook.
 *
 * Flow:
 *   1. peek the manifest (via a temp-dir install) so we can show the user
 *      what they're about to grant
 *   2. open the capability grant sheet (via `useWasmCapabilityGrant`)
 *   3. on confirm, finalize the install through the manager so manifest
 *      validation, descriptor projection, and Dexie wiring all happen
 *   4. on cancel, the staged bundle stays in place and the user can
 *      revisit the grant later from per-plugin settings
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
import { previewBundleManifest } from "@/lib/plugin/package/http-installer"

export interface InstallWasmPluginButtonProps {
  className?: string
  /** Optional callback after a successful install. */
  onInstalled?: (pluginId: string) => void
}

interface PickedPath {
  /** Absolute filesystem path of the user-picked file. */
  path: string
  /** Whether the file is a `.wasm` (no manifest extraction needed). */
  isBareWasm: boolean
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
      { name: labels.bundleFilter, extensions: ["wasm", "zip"] },
      { name: labels.allFilesFilter, extensions: ["*"] },
    ],
  })
  if (typeof selected !== "string") return null
  return {
    path: selected,
    isBareWasm: selected.toLowerCase().endsWith(".wasm"),
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

      // Preview manifest. For bare .wasm we go straight to install with no
      // preview (no plugin.json to surface); for .zip we peek so we can show
      // the grant sheet with the real declared permissions before install.
      let manifest: import("@/types/plugin").PluginManifest | null = null
      let authorFingerprint: string | undefined
      if (!picked.isBareWasm) {
        const preview = await previewBundleManifest({
          bundleUrl: pathToFileUrl(picked.path),
        })
        manifest = preview.manifest
        authorFingerprint = preview.authorFingerprint
          ? shortFingerprint(preview.authorFingerprint)
          : undefined
      }

      // We need *some* manifest before opening the grant sheet. For bare
      // .wasm sideloads, build a minimal stub the user can grant against —
      // `description` is a stored manifest field, not user-facing prose, so
      // it stays in English to keep the persisted record stable.
      const grantManifest: import("@/types/plugin").PluginManifest = manifest ?? {
        id: deriveIdFromPath(picked.path),
        name: pathBaseName(picked.path),
        version: "0.0.0",
        description: "Local WASM plugin (sideloaded)",
        type: "wasm",
        capabilities: [],
        wasmMain: pathBaseName(picked.path),
        wasm: { apiVersion: "0.1.0" },
        permissions: [],
      }

      const decision = await grant.requestGrant({
        manifest: grantManifest,
        authorFingerprint,
      })
      if (!decision) {
        // Cancelled grant — abort before any disk write.
        return
      }

      const manager = getPluginManager()
      const plugin = await manager.installWasmPluginFromLocalFile(picked.path, decision.decision)
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

function pathBaseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function deriveIdFromPath(p: string): string {
  return pathBaseName(p)
    .replace(/\.(wasm|zip)$/i, "")
    .replace(/[^a-zA-Z0-9.-]/g, "-")
    .toLowerCase()
}

function pathToFileUrl(p: string): string {
  // The HTTP installer command accepts file:// URLs as well as https://.
  // We forward the absolute path verbatim — Rust normalizes via reqwest
  // when scheme is https, and via std::fs when scheme is file://.
  if (/^https?:\/\//i.test(p) || p.startsWith("file://")) return p
  // Windows: backslash → forward slash; ensure double-slash after file:.
  const normalized = p.replace(/\\/g, "/")
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`
}
