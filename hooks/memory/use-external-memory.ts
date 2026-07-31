"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { useProjectStore } from "@/stores/project/project-store"
import { allRootPaths, primaryRootOf } from "@/lib/workspace/roots"
import { discoverExternalMemory } from "@/lib/memory/external/discover"
import { detectPlatform, resolveHome } from "@/lib/memory/external/home"
import { joinPath } from "@/lib/claude/instructions/paths"
import type { ExternalFs, ExternalMemoryFile } from "@/lib/memory/external/types"

/** Real fs adapter over `lib/file/file-operations.ts` (mirrors instructions/load.realFs). */
function realFs(): ExternalFs {
  return {
    async exists(path) {
      const { exists } = await import("@/lib/file/file-operations")
      return exists(path)
    },
    async readDir(path) {
      const { readDir } = await import("@/lib/file/file-operations")
      return readDir(path)
    },
    async stat(path) {
      const { statFile } = await import("@/lib/file/file-operations")
      const s = await statFile(path)
      return { size: s.size, isFile: s.isFile }
    },
  }
}

export interface UseExternalMemory {
  files: ExternalMemoryFile[]
  loading: boolean
  error: string | null
  /** True off-desktop — the feature needs filesystem access. */
  unsupported: boolean
  /** Roots writes are confined to (home agent dirs + workspace roots). */
  allowedRoots: string[]
  refresh: () => void
}

export interface UseExternalMemoryDeps {
  /** Inject discovery (tests). */
  discover?: typeof discoverExternalMemory
  /** Inject home resolution (tests). */
  resolveHomeFn?: typeof resolveHome
  /** Inject fs (tests). */
  fs?: ExternalFs
  /** Override desktop detection (tests). */
  isDesktop?: boolean
  /** Override platform detection (tests). */
  platform?: ReturnType<typeof detectPlatform>
}

/**
 * Discover the external agent memory files for the active workspace. Desktop
 * only — returns `unsupported` off-Tauri. Re-runs when the active workspace
 * roots change or `refresh()` is called.
 */
export function useExternalMemory(deps: UseExternalMemoryDeps = {}): UseExternalMemory {
  const desktop = deps.isDesktop ?? isTauri()

  const active = useProjectStore((s) => {
    const id = s.activeProjectId
    return id ? (s.projects.find((p) => p.id === id) ?? null) : null
  })
  const roots = useMemo(() => (active ? allRootPaths(active) : []), [active])
  const cwd = useMemo(
    () => (active ? (primaryRootOf(active)?.path ?? undefined) : undefined),
    [active]
  )

  const [files, setFiles] = useState<ExternalMemoryFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [home, setHome] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const rootsKey = roots.join("|")
  useEffect(() => {
    // Off-desktop the feature is inert; `files` stays at its initial [].
    if (!desktop) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const fs = deps.fs ?? realFs()
        const resolved = await (deps.resolveHomeFn ?? resolveHome)()
        if (cancelled) return
        setHome(resolved)
        if (!resolved) {
          setFiles([])
          setError("home-unresolved")
          return
        }
        const discover = deps.discover ?? discoverExternalMemory
        const result = await discover({
          home: resolved,
          roots,
          cwd,
          platform: deps.platform ?? detectPlatform(),
          fs,
        })
        if (!cancelled) setFiles(result)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // rootsKey/cwd capture the workspace; nonce forces a manual refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, rootsKey, cwd, nonce])

  // Writes are confined to the agent home dirs plus the active workspace roots.
  const allowedRoots = useMemo(() => {
    const list = [...roots]
    if (home) {
      list.push(joinPath(home, ".claude"), joinPath(home, ".codex"))
    }
    return list
  }, [roots, home])

  return {
    files,
    loading,
    error,
    unsupported: !desktop,
    allowedRoots,
    refresh,
  }
}
