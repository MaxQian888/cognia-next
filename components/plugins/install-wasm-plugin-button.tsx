"use client"

/**
 * "Install local WASM plugin" entry button.
 *
 * Opens the Tauri file picker for a `.wasm` or `.zip` bundle, then runs
 * the install flow:
 *
 *   1. peek the manifest (via a temp-dir install) so we can show the user
 *      what they're about to grant
 *   2. open the capability grant sheet (via `useWasmCapabilityGrant`)
 *   3. on confirm, finalize the install through the manager so manifest
 *      validation, descriptor projection, and Dexie wiring all happen
 *   4. on cancel, the staged bundle stays in place and the user can
 *      revisit the grant later from per-plugin settings
 *
 * Sister button to the install-from-URL dialog; the two share the grant
 * hook so first-time grants behave the same regardless of source.
 */

import { useCallback, useState } from "react"
import { FilePlus2Icon, Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { useWasmCapabilityGrant } from "./use-wasm-capability-grant"
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

async function pickFile(): Promise<PickedPath | null> {
  if (!canUseTauriInvoke()) return null
  const dialog = await import("@tauri-apps/plugin-dialog")
  const selected = await dialog.open({
    multiple: false,
    directory: false,
    title: "Select a WASM plugin bundle (.wasm or .zip)",
    filters: [
      { name: "WASM plugin bundle", extensions: ["wasm", "zip"] },
      { name: "All files", extensions: ["*"] },
    ],
  })
  if (typeof selected !== "string") return null
  return {
    path: selected,
    isBareWasm: selected.toLowerCase().endsWith(".wasm"),
  }
}

export function InstallWasmPluginButton({ className, onInstalled }: InstallWasmPluginButtonProps) {
  const grant = useWasmCapabilityGrant()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClick = useCallback(async () => {
    setError(null)
    if (!canUseTauriInvoke()) {
      setError("Local WASM plugin install requires the Tauri desktop runtime.")
      return
    }
    try {
      setBusy(true)
      const picked = await pickFile()
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
      // no manifest field will be populated except the required ones.
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

      // Hand off to the manager. For .zip bundles the manager's existing
      // install path opens the file. For bare .wasm we wrap it in a tiny
      // implicit bundle (caller code path).
      const manager = getPluginManager()
      const plugin = await manager.installWasmPluginFromLocalFile(picked.path, decision.decision)
      onInstalled?.(plugin.manifest.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [grant, onInstalled])

  return (
    <>
      <Button
        onClick={handleClick}
        disabled={busy}
        className={className}
        data-testid="install-wasm-plugin-button"
      >
        {busy ? (
          <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden />
        ) : (
          <FilePlus2Icon className="mr-2 size-4" aria-hidden />
        )}
        Install local WASM plugin
      </Button>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {grant.sheet}
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
