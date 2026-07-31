/**
 * useSecureFileOps — React binding over the secure file-IO façade.
 *
 * Derives a `FileAccessPolicy` from the active workspace's roots (so a
 * component never has to assemble one), exposes a policy-scoped
 * `SecureFileSystem`, and offers toast-wrapped convenience helpers that surface
 * an i18n'd error on denial / failure instead of throwing. Also subscribes to
 * the file-op audit ring buffer for diagnostics surfaces.
 *
 * Pass an explicit `policy` to bypass the workspace derivation (e.g. a plugin
 * sandbox dir) or `policyOverrides` to layer read-only / denied-glob / byte
 * limits onto the workspace roots.
 */

"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useProjectStore } from "@/stores/project/project-store"
import { allRootPaths } from "@/lib/workspace/roots"
import { defaultFilePolicy } from "@/lib/files/permissions"
import { createSecureFs, FileAccessError, type SecureFileSystem } from "@/lib/files/secure-fs"
import { clearFileAudit, getFileAudit, subscribeFileAudit } from "@/lib/files/audit"
import type { FileAccessPolicy, FileAuditEntry } from "@/types/files"

export interface UseSecureFileOpsOptions {
  /** Replace the workspace-derived policy entirely. */
  policy?: FileAccessPolicy
  /** Layer read-only / denied-globs / maxBytes onto the workspace roots. */
  policyOverrides?: Omit<FileAccessPolicy, "allowedRoots">
  /** Surface an i18n toast on denial / failure (default true). */
  toastOnError?: boolean
}

export interface UseSecureFileOps {
  /** Policy-scoped façade — throws `FileAccessError` on denial. */
  fs: SecureFileSystem
  /** The active policy (derived or supplied). */
  policy: FileAccessPolicy
  /** True when the policy permits at least one directory. */
  ready: boolean
  /** Newest-first recent file operations (allowed + denied). */
  recentAudit: FileAuditEntry[]
  /** Clear the audit ring buffer. */
  clearAudit: () => void
  /** Read text, returning null (and toasting) on error. */
  readText: (path: string) => Promise<string | null>
  /** Write text, returning false (and toasting) on error. */
  writeText: (path: string, content: string) => Promise<boolean>
  /** Remove a path, returning false (and toasting) on error. */
  remove: (path: string, options?: { recursive?: boolean }) => Promise<boolean>
}

export function useSecureFileOps(options: UseSecureFileOpsOptions = {}): UseSecureFileOps {
  const t = useTranslations("fileOps")
  const { policy: explicitPolicy, policyOverrides, toastOnError = true } = options

  const active = useProjectStore((s) => {
    const id = s.activeProjectId
    return id ? (s.projects.find((p) => p.id === id) ?? null) : null
  })
  const paths = useMemo(() => (active ? allRootPaths(active) : []), [active])

  const policy = useMemo<FileAccessPolicy>(
    () => explicitPolicy ?? defaultFilePolicy(paths, policyOverrides),
    [explicitPolicy, paths, policyOverrides]
  )

  const fs = useMemo(() => createSecureFs(policy), [policy])
  const ready = policy.allowAnyPath === true || policy.allowedRoots.length > 0

  // Seed from the current buffer (initializer) and track subsequent changes via
  // the subscription — no synchronous set-in-effect needed.
  const [recentAudit, setRecentAudit] = useState<FileAuditEntry[]>(() => getFileAudit())
  useEffect(() => subscribeFileAudit(() => setRecentAudit(getFileAudit())), [])

  const handleError = useCallback(
    (err: unknown) => {
      if (!toastOnError) return
      if (err instanceof FileAccessError) {
        toast.error(t("denied", { detail: err.decision.detail ?? err.decision.reason }))
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t("failed", { message }))
    },
    [t, toastOnError]
  )

  const readText = useCallback(
    async (path: string): Promise<string | null> => {
      try {
        return await fs.readText(path)
      } catch (err) {
        handleError(err)
        return null
      }
    },
    [fs, handleError]
  )

  const writeText = useCallback(
    async (path: string, content: string): Promise<boolean> => {
      try {
        await fs.writeText(path, content)
        return true
      } catch (err) {
        handleError(err)
        return false
      }
    },
    [fs, handleError]
  )

  const remove = useCallback(
    async (path: string, opts?: { recursive?: boolean }): Promise<boolean> => {
      try {
        await fs.remove(path, opts)
        return true
      } catch (err) {
        handleError(err)
        return false
      }
    },
    [fs, handleError]
  )

  const clearAudit = useCallback(() => {
    clearFileAudit()
    if (toastOnError) toast.success(t("auditCleared"))
  }, [t, toastOnError])

  return { fs, policy, ready, recentAudit, clearAudit, readText, writeText, remove }
}
