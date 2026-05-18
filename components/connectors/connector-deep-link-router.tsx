"use client"

/**
 * ConnectorDeepLinkRouter — Task 42.
 *
 * Subscribes to `cognia://connector/oauth/<adapterType>?code=…&state=…`
 * deep-link URLs forwarded by the Tauri deep-link plugin.
 *
 * For each matched URL:
 *   1. Validate `state` vs `sessionStorage["connector-oauth-state"]`.
 *   2. Look up the OAuth handler in oauthRegistry.
 *   3. Invoke the handler; toast success / error.
 *
 * No-op in web mode.
 */

import { useEffect } from "react"
import { toast } from "sonner"
import { isTauri } from "@/lib/tauri"
import { onDeepLink } from "@/lib/tauri/deep-link"
import { oauthRegistry } from "@/lib/connectors/oauth-registry"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { isPlatformKind } from "@/types/connectors/platform-kind"

/** Matches: cognia://connector/oauth/<adapterType>?code=…&state=… */
const OAUTH_PATH_RE = /^cognia:\/\/connector\/oauth\/([^?#/]+)/

function parseOAuthUrl(raw: string): {
  adapterType: string
  code: string
  state: string
} | null {
  const match = OAUTH_PATH_RE.exec(raw)
  if (!match) return null
  const adapterType = match[1]
  let url: URL
  try {
    // URL constructor needs an http base to parse query params
    url = new URL(raw.replace(/^cognia:\/\//, "https://cognia-placeholder/"))
  } catch {
    return null
  }
  const code = url.searchParams.get("code") ?? ""
  const state = url.searchParams.get("state") ?? ""
  return { adapterType, code, state }
}

async function handleOAuthUrl(raw: string): Promise<void> {
  const parsed = parseOAuthUrl(raw)
  if (!parsed) return // not an OAuth deep-link

  const { adapterType, code, state } = parsed

  // ── Step 1: validate state ─────────────────────────────────────────────────
  const storedState =
    typeof sessionStorage !== "undefined"
      ? (sessionStorage.getItem("connector-oauth-state") ?? "")
      : ""

  if (!state || state !== storedState) {
    toast.error("OAuth state mismatch")
    return
  }

  // ── Step 2: look up handler ────────────────────────────────────────────────
  if (!isPlatformKind(adapterType)) {
    toast.error(`No OAuth handler for unknown platform: ${adapterType}`)
    return
  }

  const handler = oauthRegistry.get(adapterType as PlatformKind)
  if (!handler) {
    toast.error(`No OAuth handler for ${adapterType}`)
    return
  }

  // ── Step 3: invoke handler ─────────────────────────────────────────────────
  // State is forwarded so platform-specific handlers can decode an
  // adapterId out of it (Lark uses `lark:<adapterId>:<nonce>` to scope
  // the exchange to a specific configured account). ADR-0009 v41 / D2.
  try {
    await handler(code, state)
    toast.success(`${adapterType} connected successfully`)
  } catch (err) {
    toast.error(`OAuth exchange failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function ConnectorDeepLinkRouter({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | null = null
    let cancelled = false

    void (async () => {
      unlisten = await onDeepLink((urls: string[]) => {
        for (const url of urls) {
          void handleOAuthUrl(url)
        }
      })
      if (cancelled && unlisten) {
        unlisten()
        unlisten = null
      }
    })()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return <>{children}</>
}
