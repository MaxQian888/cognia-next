"use client"

/**
 * DesktopNetworkRuntimeInitializer — installs the host network transport into
 * the framework-agnostic packages that reach the network through a runtime
 * adapter (`@cognia/web-search`, `@cognia/rag`).
 *
 * Without it those packages keep their inert bare-`fetch` defaults: web search
 * and Cohere reranking are blocked by the packaged shell's `connect-src` CSP,
 * and neither obeys the proxy the user configured. See
 * `lib/network/desktop-network-runtime.ts` for why the failure is invisible in
 * `pnpm dev`.
 *
 * Mount order matters: this must run before any surface that can issue a
 * search or a rerank — the composer's search tool, the standalone answer
 * pipeline, and every RAG retrieval path. It is placed at the head of the
 * deferred core-chat chunk alongside `ProviderCoreRuntimeInitializer`, which
 * solves the same problem for `@cognia/provider-core`.
 *
 * `useRef` makes the mount idempotent under React 18 Strict Mode's
 * double-invoke; `installDesktopNetworkRuntime` is idempotent too, so the two
 * guards are belt-and-braces rather than redundant — the headless host calls
 * the installer directly, without this component.
 */

import { useEffect, useRef } from "react"

import { installDesktopNetworkRuntime } from "@/lib/network/desktop-network-runtime"

export function DesktopNetworkRuntimeInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    installDesktopNetworkRuntime()
  }, [])

  return null
}

export default DesktopNetworkRuntimeInitializer
