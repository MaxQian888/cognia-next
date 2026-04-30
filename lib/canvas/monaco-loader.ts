"use client"

/**
 * Monaco loader configuration. By default `@monaco-editor/react` pulls
 * monaco from a CDN (jsdelivr) which is fine for browser-mode dev,
 * but the Tauri production build runs under a strict CSP and may have
 * no internet access — so we redirect the loader to local assets
 * shipped in `public/monaco/vs/`.
 *
 * Run this once on app boot before any `<Editor>` mounts. Idempotent:
 * subsequent calls are no-ops because `loader.config` only takes
 * effect on first init.
 *
 * Asset bundling: `public/monaco/vs/` ships with a `loader.js`
 * + worker bundles. The recommended workflow is a `prebuild`
 * script that copies `node_modules/monaco-editor/min/vs` into
 * `public/monaco/vs/` so a Tauri build can run offline.
 */

import { loader } from "@monaco-editor/react"
import { isTauri } from "@/lib/tauri"

let configured = false

export function configureMonacoLoader(): void {
  if (configured) return
  configured = true
  if (typeof window === "undefined") return

  // In Tauri builds the page is served from `tauri://localhost` and
  // the strict CSP blocks any cross-origin script. Point the loader
  // at the local copy under `/monaco/vs/`.
  if (isTauri()) {
    loader.config({ paths: { vs: "/monaco/vs" } })
    return
  }

  // Web mode: respect a build-time override (e.g. for CI offline
  // testing) when present, otherwise leave the default CDN.
  const override =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_MONACO_VS_PATH : undefined
  if (override) {
    loader.config({ paths: { vs: override } })
  }
}
