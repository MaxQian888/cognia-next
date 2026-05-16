"use client"

// React hooks for the Codex subscription subsystem. Three reads + one write:
//
//   useCodexCredential()       — keychain → state, refresh + signOut + adopt
//   useCodexDiscovery()        — probe ~/.codex/auth.json + codex-cli keyring
//
// All hooks degrade to no-ops outside Tauri (return null / empty).

import { useCallback, useEffect, useMemo, useState } from "react"

import { isTauri } from "@/lib/tauri"

import {
  clearCodexCredential,
  isCodexCredentialFresh,
  loadCodexCredential,
  saveCodexCredential,
} from "./credential-store"
import { discoverCodexAuth, discoveredToCredential } from "./discovery"
import { refreshCodexToken, revokeCodexToken, tokenResponseToCredential } from "./oauth"
import type { CodexCredential, DiscoveredCodexAuth } from "./types"

export interface UseCodexCredentialResult {
  credential: CodexCredential | null
  isFresh: boolean
  loading: boolean
  /** Re-read from the keyring. Use after the login dialog persists. */
  reload: () => Promise<void>
  /** Adopt a discovered codex-cli credential into our own keyring. */
  adoptDiscovered: (discovered: DiscoveredCodexAuth) => Promise<CodexCredential | null>
  /** Force a refresh exchange and persist the rotated tokens. */
  refresh: () => Promise<CodexCredential | null>
  /** Clear the keyring entry. Optionally revoke server-side too. */
  signOut: (options?: { revoke?: boolean }) => Promise<void>
}

export function useCodexCredential(): UseCodexCredentialResult {
  const [credential, setCredential] = useState<CodexCredential | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      await Promise.resolve()
      setCredential(null)
      setLoading(false)
      return
    }
    try {
      const got = await loadCodexCredential()
      setCredential(got)
    } finally {
      setLoading(false)
    }
  }, [])

  const adoptDiscovered = useCallback(async (discovered: DiscoveredCodexAuth) => {
    const next = discoveredToCredential(discovered)
    if (!next) return null
    await saveCodexCredential(next)
    setCredential(next)
    return next
  }, [])

  const refresh = useMemo(
    () => async () => {
      if (!credential || !credential.refreshToken) return null
      if (credential.authMode !== "chatgpt") return credential
      const response = await refreshCodexToken(credential.refreshToken)
      const next = tokenResponseToCredential(response, {
        authMode: "chatgpt",
        previous: credential,
      })
      await saveCodexCredential(next)
      setCredential(next)
      return next
    },
    [credential]
  )

  const signOut = useMemo(
    () =>
      async (options: { revoke?: boolean } = {}) => {
        if (options.revoke && credential?.refreshToken) {
          // Best-effort: log the failure but don't block local clear.
          try {
            await revokeCodexToken(credential.refreshToken)
          } catch (err) {
            console.warn("codex revoke_token failed:", err)
          }
        }
        await clearCodexCredential()
        setCredential(null)
      },
    [credential]
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) {
        if (alive) {
          setCredential(null)
          setLoading(false)
        }
        return
      }
      try {
        const got = await loadCodexCredential()
        if (alive) setCredential(got)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return {
    credential,
    isFresh: isCodexCredentialFresh(credential),
    loading,
    reload,
    adoptDiscovered,
    refresh,
    signOut,
  }
}

export interface UseCodexDiscoveryResult {
  discovered: DiscoveredCodexAuth | null
  loading: boolean
  error: string | null
  /** Force a re-probe (e.g. after the user runs `codex login` in a terminal). */
  reload: () => Promise<void>
}

export function useCodexDiscovery(): UseCodexDiscoveryResult {
  const [discovered, setDiscovered] = useState<DiscoveredCodexAuth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setDiscovered(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const got = await discoverCodexAuth()
      setDiscovered(got)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDiscovered(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) {
        if (alive) {
          setDiscovered(null)
          setLoading(false)
        }
        return
      }
      try {
        const got = await discoverCodexAuth()
        if (alive) setDiscovered(got)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return { discovered, loading, error, reload }
}
