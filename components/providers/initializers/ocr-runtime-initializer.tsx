"use client"

import { useEffect, useRef } from "react"

import { installOcrRuntime } from "@/lib/ocr/runtime"
import { loggers } from "@/lib/logging"

const log = loggers.shell

/**
 * Boot-time initializer for the OCR subsystem. Calls `installOcrRuntime()` once
 * on first paint so the shared registry is populated (20 providers + native
 * invokers) before any surface dispatches — `/ocr`, the agent OCR tool, the
 * composer menu, connectors inbound, and twin ingest all rely on this.
 *
 * Before this existed the registry was only populated as a side effect of
 * opening OCR settings, so those surfaces hit an empty registry. `install` is
 * cheap (registers provider objects + wires Tauri invokers; the heavy WASM/
 * model assets stay lazy until a provider actually runs) and idempotent.
 * Following the `ProjectStoreInitializer` shape so `app/layout.tsx` stays
 * homogeneous.
 */
export function OcrRuntimeInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void installOcrRuntime().catch((err) => log.warn("ocr-runtime: boot install threw", { err }))
  }, [])

  return null
}

export default OcrRuntimeInitializer
