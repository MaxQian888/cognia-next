"use client"

/**
 * Which status runtime this page is running in (primary, mirror or app).
 *
 * The answer comes from a `<meta name="cognia-status-runtime">` the status
 * Worker or the mirror injects into the exported HTML, plus two build-time
 * overrides. It cannot be known while the page is prerendered, so the hook
 * returns null on the server and during hydration, and the resolved runtime
 * right after. The page renders its skeleton until then, which also keeps
 * every live-data subtree client-only.
 */

import { useSyncExternalStore } from "react"

import {
  resolveStatusRuntime,
  STATUS_RUNTIME_META_NAME,
  type StatusRuntime,
} from "@/lib/status/public-status"

export function readStatusRuntimeMeta(doc: Document): string | null {
  const element = doc.querySelector(`meta[name="${STATUS_RUNTIME_META_NAME}"]`)
  return element?.getAttribute("content") ?? null
}

let cached: { key: string; runtime: StatusRuntime } | null = null

/** Resolve the runtime from the live document; stable while inputs are. */
export function currentStatusRuntime(): StatusRuntime {
  const metaContent = readStatusRuntimeMeta(document)
  // Literal `process.env.NEXT_PUBLIC_*` reads so the build inlines them.
  const apiOverride = process.env.NEXT_PUBLIC_STATUS_API_URL ?? null
  const pageOverride = process.env.NEXT_PUBLIC_STATUS_PAGE_URL ?? null
  const allowLoopbackHttp = process.env.NODE_ENV !== "production"
  const key = JSON.stringify([metaContent, apiOverride, pageOverride, allowLoopbackHttp])
  if (cached?.key === key) return cached.runtime
  const runtime = resolveStatusRuntime({
    metaContent,
    apiOverride,
    pageOverride,
    allowLoopbackHttp,
  })
  cached = { key, runtime }
  return runtime
}

const subscribe = () => () => {}
const serverSnapshot = () => null

export function useStatusRuntime(): StatusRuntime | null {
  return useSyncExternalStore<StatusRuntime | null>(subscribe, currentStatusRuntime, serverSnapshot)
}
