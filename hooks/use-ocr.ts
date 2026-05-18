"use client"

/**
 * React hook that wraps `lib/ocr/extract()` with streaming state. Used by
 * the composer menu and the slash-command UI.
 */

import { useCallback, useRef, useState } from "react"
import { extract, type ExtractDeps } from "@/lib/ocr/index"
import { OcrError, type OcrErrorCode, type OcrInput, type OcrResult } from "@/lib/ocr/types"

export interface UseOcrState {
  status: "idle" | "running" | "success" | "error"
  result: OcrResult | null
  error: { code: OcrErrorCode; message: string } | null
  abort: () => void
  run: (input: OcrInput) => Promise<OcrResult | null>
  reset: () => void
}

export function useOcr(deps: ExtractDeps | (() => ExtractDeps | null)): UseOcrState {
  const [status, setStatus] = useState<UseOcrState["status"]>("idle")
  const [result, setResult] = useState<OcrResult | null>(null)
  const [error, setError] = useState<UseOcrState["error"]>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const abort = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort()
      controllerRef.current = null
    }
  }, [])

  const reset = useCallback(() => {
    abort()
    setStatus("idle")
    setResult(null)
    setError(null)
  }, [abort])

  const run = useCallback(
    async (input: OcrInput): Promise<OcrResult | null> => {
      abort()
      const resolvedDeps = typeof deps === "function" ? deps() : deps
      if (!resolvedDeps) {
        const err = {
          code: "provider_failed" as OcrErrorCode,
          message: "OCR runtime is not ready.",
        }
        setError(err)
        setStatus("error")
        return null
      }
      const controller = new AbortController()
      controllerRef.current = controller
      setStatus("running")
      setError(null)
      try {
        const out = await extract({ ...input, signal: controller.signal }, resolvedDeps)
        setResult(out)
        setStatus("success")
        return out
      } catch (err) {
        // Cross-module `instanceof OcrError` can fail when jest re-resolves
        // `@/lib/ocr/types` through a different require chain. Duck-type on the
        // `code`+`providerId` shape OcrError stamps onto its instances so the
        // hook surfaces the right discriminant either way.
        const isOcrError =
          err instanceof OcrError ||
          (err !== null &&
            typeof err === "object" &&
            "code" in err &&
            "providerId" in err &&
            (err as { name?: string }).name === "OcrError")
        if (isOcrError) {
          const e = err as { code: import("@/lib/ocr/types").OcrErrorCode; message: string }
          setError({ code: e.code, message: e.message })
        } else {
          setError({
            code: "provider_failed",
            message: err instanceof Error ? err.message : String(err),
          })
        }
        setStatus("error")
        return null
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null
      }
    },
    [abort, deps]
  )

  return { status, result, error, abort, run, reset }
}
