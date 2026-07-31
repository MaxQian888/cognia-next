"use client"

/**
 * ProviderCoreRuntimeInitializer — installs the provider-core runtime adapters
 * once at app startup so every local-provider management call (status probes,
 * model listing, pull/delete/stop, embeddings) reaches the network through the
 * Rust `proxy_http_request` command instead of a bare renderer `fetch`, which
 * the packaged shell's CSP blocks outright.
 *
 * Without this, `provider-core` keeps its inert `defaultProxyFetch` and the
 * whole local-provider surface is dead on the desktop while looking healthy in
 * `pnpm dev` (no CSP there). See `lib/ai/provider-core-runtime-deps.ts`.
 *
 * `setProviderCoreRuntimeAdapters` must run exactly once; the `useRef` guard
 * makes this idempotent under React 18 Strict Mode's double-invoke.
 * Returns null — provider-shaped, not a render component. Mirrors
 * `RoutingRuntimeInitializer`.
 */

import { useEffect, useRef } from "react"

import { setProviderCoreRuntimeAdapters } from "@cognia/provider-core/providers/runtime-adapters"
import { buildProviderCoreRuntimeAdapters } from "@/lib/ai/provider-core-runtime-deps"

export function ProviderCoreRuntimeInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    setProviderCoreRuntimeAdapters(buildProviderCoreRuntimeAdapters())
  }, [])

  return null
}

export default ProviderCoreRuntimeInitializer
