"use client"

/**
 * React glue around `WasmCapabilityGrantSheet`. Exposes an imperative
 * `requestGrant(manifest, fingerprint?) => Promise<decision | null>` so
 * the install button (or any other entry point) can `await` the user's
 * decision without managing dialog state inline.
 *
 * Resolves with the decision the user confirmed, or `null` if they
 * cancelled. The hook automatically persists the decision via
 * `applyWasmCapabilityGrant` — callers only need to forward the returned
 * `preopens` to the Rust host.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import {
  WasmCapabilityGrantSheet,
  type WasmCapabilityGrantDecision,
} from "@/components/plugins/dialogs/wasm-capability-grant-sheet"
import { applyWasmCapabilityGrant } from "@/lib/plugin/security/wasm-grant"
import type { PluginManifest } from "@/types/plugin"

export interface RequestGrantArgs {
  manifest: PluginManifest
  authorFingerprint?: string
}

export interface RequestGrantResult {
  decision: WasmCapabilityGrantDecision
  /** Final preopens to pass to the Rust host (post-persistence). */
  preopens: string[]
}

export interface UseWasmCapabilityGrant {
  /** Live JSX element to render somewhere in the tree (typically once). */
  sheet: React.ReactNode
  /** Mounts the dialog and resolves on confirm/cancel. */
  requestGrant: (args: RequestGrantArgs) => Promise<RequestGrantResult | null>
}

export function useWasmCapabilityGrant(): UseWasmCapabilityGrant {
  const [open, setOpen] = useState(false)
  const [manifest, setManifest] = useState<PluginManifest | null>(null)
  const [fingerprint, setFingerprint] = useState<string>("")
  const resolverRef = useRef<((value: RequestGrantResult | null) => void) | null>(null)

  const cleanup = useCallback(() => {
    setOpen(false)
    setManifest(null)
    setFingerprint("")
    resolverRef.current = null
  }, [])

  const requestGrant = useCallback<UseWasmCapabilityGrant["requestGrant"]>(
    ({ manifest, authorFingerprint }) => {
      if (manifest.type !== "wasm") {
        return Promise.reject(
          new Error(`requestGrant: manifest.type must be "wasm", got "${manifest.type}"`)
        )
      }
      return new Promise<RequestGrantResult | null>((resolve) => {
        resolverRef.current = resolve
        setManifest(manifest)
        setFingerprint(authorFingerprint ?? "")
        setOpen(true)
      })
    },
    []
  )

  const handleConfirm = useCallback(
    async (decision: WasmCapabilityGrantDecision) => {
      const result = await applyWasmCapabilityGrant(decision)
      const value: RequestGrantResult = {
        decision: {
          ...decision,
          grantedPermissions: result.permissions,
          grantedPreopens: result.preopens,
        },
        preopens: result.preopens,
      }
      resolverRef.current?.(value)
      cleanup()
    },
    [cleanup]
  )

  const handleCancel = useCallback(() => {
    resolverRef.current?.(null)
    cleanup()
  }, [cleanup])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && resolverRef.current) {
        // Dialog was dismissed without an explicit cancel click (e.g. ESC,
        // overlay click). Treat as cancel so callers don't hang.
        resolverRef.current(null)
        cleanup()
      } else {
        setOpen(next)
      }
    },
    [cleanup]
  )

  const sheet = useMemo(() => {
    if (!manifest) return null
    return (
      <WasmCapabilityGrantSheet
        manifest={manifest}
        authorFingerprint={fingerprint}
        open={open}
        onOpenChange={handleOpenChange}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    )
  }, [manifest, fingerprint, open, handleOpenChange, handleConfirm, handleCancel])

  return { sheet, requestGrant }
}
