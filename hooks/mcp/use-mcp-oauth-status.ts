"use client"

import { useCallback, useEffect, useState } from "react"

import { isTauri } from "@/lib/tauri"
import { mcpOAuthStatus } from "@/lib/mcp/oauth-tauri"
import type { McpTransport } from "@/lib/claude/types"

export type McpOAuthUiStatus = "loading" | "none" | "authorized" | "expired" | "unsupported"

export interface UseMcpOAuthStatus {
  status: McpOAuthUiStatus
  expiresAtMs?: number
  refetch: () => Promise<void>
}

/**
 * Track a remote MCP server's stored OAuth state (keyring-backed, via Tauri).
 * stdio servers and web mode resolve to a terminal status without probing.
 */
/** Derive the non-async status (stdio / web) without touching the keyring. */
function initialStatus(transport: McpTransport): McpOAuthUiStatus {
  if (transport === "stdio") return "unsupported"
  return isTauri() ? "loading" : "none"
}

export function useMcpOAuthStatus(serverName: string, transport: McpTransport): UseMcpOAuthStatus {
  const [status, setStatus] = useState<McpOAuthUiStatus>(() => initialStatus(transport))
  const [expiresAtMs, setExpiresAtMs] = useState<number | undefined>(undefined)

  // Shared async probe — setState happens only after the awaited call, so it
  // never fires synchronously inside the effect body.
  const probe = useCallback(async () => {
    try {
      const s = await mcpOAuthStatus(serverName)
      setExpiresAtMs(s.expiresAtMs)
      if (!s.hasTokens) setStatus("none")
      else if (s.expiresAtMs && s.expiresAtMs < Date.now()) setStatus("expired")
      else setStatus("authorized")
    } catch {
      setStatus("none")
    }
  }, [serverName])

  useEffect(() => {
    // The synchronous states (stdio / web) are already set by the initializer.
    if (transport === "stdio" || !isTauri()) return
    let cancelled = false
    void (async () => {
      if (!cancelled) await probe()
    })()
    return () => {
      cancelled = true
    }
  }, [transport, probe])

  const refetch = useCallback(async () => {
    if (transport === "stdio" || !isTauri()) return
    await probe()
  }, [transport, probe])

  return { status, expiresAtMs, refetch }
}
