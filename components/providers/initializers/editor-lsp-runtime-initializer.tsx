"use client"

/**
 * Brings the editor/renderer LSP data plane online at desktop boot.
 *
 * The Settings → Language Servers panel, the editor LSP hint, and Monaco
 * diagnostics all speak to the `cognia.lsp-service` sidecar channel. Nothing
 * spawned that sidecar or ran the LSP registry bootstrap unless a real `.vsix`
 * VS Code extension happened to load, so on a default install every `lsp:*`
 * RPC returned `not_loaded` and the whole surface was an inert shell.
 *
 * On mount (Tauri main window only) we run `ensureEditorLspRuntime()`, which
 * spawns the headless host, configures the dispatcher/monaco-bridge/registry,
 * and subscribes to the push channel. Idempotent and self-gated on
 * `isTauri()`; a no-op on web/Capacitor.
 */

import { useEffect, useRef } from "react"

import { isTauri } from "@/lib/tauri"
import { ensureEditorLspRuntime } from "@/lib/lsp/ensure-editor-lsp-runtime"

export function EditorLspRuntimeInitializer() {
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    if (!isTauri()) return
    started.current = true
    void ensureEditorLspRuntime()
  }, [])
  return null
}

export default EditorLspRuntimeInitializer
