"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { requestBrowserUrl } from "@/lib/browser/open-url-request"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import {
  sandboxPreviewCreate,
  sandboxPreviewList,
  sandboxPreviewOpen,
  sandboxPreviewRevoke,
  type CreateSandboxPreview,
  type PreviewAudience,
  type PreviewGrantV1,
} from "@/lib/sandbox/previews"

/** Capabilities never enter a store, DOM attribute, error message or persisted state. */
export function useSandboxPreviewLinks(projectId: string) {
  const [grants, setGrants] = useState<PreviewGrantV1[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<"load" | "action" | "browser" | "clipboard" | null>(null)
  const [copyable, setCopyable] = useState<string[]>([])
  const [now, setNow] = useState(Date.now)
  const capabilities = useRef(new Map<string, { url: string; until: number }>())
  const epoch = useRef(0)
  const inFlight = useRef(false)
  const [scope, setScope] = useState(projectId)
  if (scope !== projectId) {
    setScope(projectId)
    setCopyable([])
    setGrants([])
    setBusy(false)
    setLoading(true)
    setError(null)
  }

  const load = useCallback(async () => {
    const current = epoch.current
    try {
      const next = await sandboxPreviewList(projectId)
      if (current === epoch.current) {
        setGrants(next)
        for (const id of capabilities.current.keys()) {
          if (
            !next.some((grant) => grant.id === id && !grant.revoked && grant.expiresAt > Date.now())
          )
            capabilities.current.delete(id)
        }
        setCopyable([...capabilities.current.keys()])
        setError(null)
      }
    } catch {
      if (current === epoch.current) setError("load")
    } finally {
      if (current === epoch.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    epoch.current += 1
    const pendingCapabilities = capabilities.current
    pendingCapabilities.clear()
    inFlight.current = false
    const current = epoch.current
    void Promise.resolve().then(() => {
      if (current === epoch.current) return load()
    })
    const timer = setInterval(() => {
      const next = Date.now()
      setNow(next)
      for (const [id, value] of capabilities.current) {
        if (value.until <= next) capabilities.current.delete(id)
      }
      setCopyable([...capabilities.current.keys()])
    }, 1000)
    return () => {
      epoch.current += 1
      pendingCapabilities.clear()
      clearInterval(timer)
    }
  }, [load])

  const refresh = async () => {
    setLoading(true)
    await load()
  }

  const run = async (
    action: (current: number) => Promise<void>,
    failure: "action" | "clipboard" = "action"
  ) => {
    if (inFlight.current) return
    const current = epoch.current
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await action(current)
    } catch {
      if (current === epoch.current) setError(failure)
    } finally {
      if (current === epoch.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return {
    grants,
    loading,
    busy,
    error,
    copyable,
    now,
    refresh,
    /** A paired-device grant has no bootstrap capability: it opens on that device. */
    create: (
      request: Omit<CreateSandboxPreview, "projectId" | "audience">,
      audience: PreviewAudience = { kind: "localOwner" }
    ) =>
      run(async (current) => {
        const created = await sandboxPreviewCreate({ ...request, projectId, audience })
        if (current !== epoch.current) return
        if (created.grant.audience.kind === "localOwner") {
          capabilities.current.set(created.grant.id, {
            url: created.bootstrapUrl,
            until: Math.min(created.grant.expiresAt, Date.now() + 60_000),
          })
          setCopyable([...capabilities.current.keys()])
        }
        setGrants((previous) => [
          ...previous.filter((grant) => grant.id !== created.grant.id),
          created.grant,
        ])
      }),
    copy: (id: string) =>
      run(async (current) => {
        const capability = capabilities.current.get(id)
        if (!capability || capability.until <= Date.now()) throw new Error("bootstrap_expired")
        await writeClipboardText(capability.url)
        if (current !== epoch.current) return
        capabilities.current.delete(id)
        setCopyable([...capabilities.current.keys()])
      }, "clipboard"),
    open: (id: string) =>
      run(async (current) => {
        const created = await sandboxPreviewOpen(id)
        if (current !== epoch.current) return
        capabilities.current.delete(id)
        setCopyable([...capabilities.current.keys()])
        if (!requestBrowserUrl(created.bootstrapUrl, { backend: "embedded", source: "user" }))
          setError("browser")
      }),
    revoke: (id: string) =>
      run(async (current) => {
        const grant = await sandboxPreviewRevoke(id)
        if (current !== epoch.current) return
        capabilities.current.delete(id)
        setCopyable([...capabilities.current.keys()])
        setGrants((previous) => previous.map((row) => (row.id === id ? grant : row)))
      }),
  }
}
