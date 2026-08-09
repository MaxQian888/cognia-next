"use client"

/**
 * OCR Models tab — drives the local-model download UI for backends whose
 * weights ship out of band (currently `ocrs` and `paddle-ocr`).
 *
 * This file owns `LocalModelManager` + the Tauri bridge helpers. The OCR
 * settings shell re-exports them from `ocr-section.tsx` to preserve the
 * public import path used by other consumers and tests.
 */

import { useCallback, useEffect, useState } from "react"

import { isTauri } from "@/lib/platform/detect"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

export type PaddleModelVariant = "v6-small" | "v6-tiny"

/** Backends that ship their own downloaded model files. */
export const BACKENDS_WITH_MANAGED_MODELS: ReadonlySet<string> = new Set<string>([
  "ocrs",
  "paddle-ocr",
])

export interface ModelFileStatus {
  file_name: string
  installed: boolean
  expected_bytes: number
  actual_bytes?: number
  integrity?: "verified" | "missing" | "corrupt" | "unknown"
}

export interface ModelStatus {
  backend: string
  variant?: string
  version?: string
  integrity?: "verified" | "missing" | "corrupt" | "unknown"
  installed: boolean
  model_dir: string
  files: ModelFileStatus[]
  total_bytes: number
  legacy_files?: string[]
  legacy_model_dir?: string
  reason?: string
}

export interface DownloadProgressEvent {
  backend: string
  file_name: string
  bytes_done: number
  bytes_total: number
  file_index: number
  file_count: number
}

/**
 * Tauri-backed bridge for the local model manager. Injected so tests can
 * drive the UI without spinning up a Tauri runtime.
 */
export interface OcrModelBridge {
  status(backend: string, variant?: string): Promise<ModelStatus>
  download(backend: string, variant?: string, requestId?: string): Promise<ModelStatus>
  cancel?(requestId: string): Promise<boolean>
  /** Subscribe to download-progress events. Returns an unsubscribe fn. */
  onProgress(handler: (event: DownloadProgressEvent) => void): () => void
}

interface OcrModelsTabProps {
  providerId: string
  /**
   * Bridge to the Rust-side model manager. When omitted, the tab tries to
   * build one from Tauri's `invoke` / `listen`; tests pass a stub. Pass
   * `null` to suppress the manager entirely (e.g. on the browser shell).
   */
  bridge?: OcrModelBridge | null
  modelVariant?: PaddleModelVariant
}

/** Top-level component rendered inside the OCR detail panel's Models tab. */
export function OcrModelsTab({
  providerId,
  bridge,
  modelVariant = "v6-small",
}: OcrModelsTabProps): React.ReactElement {
  const t = useTranslations()

  if (!BACKENDS_WITH_MANAGED_MODELS.has(providerId)) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ocr-models-empty">
        {t("ocr.modelStatus.emptyNoModelFiles")}
      </p>
    )
  }
  if (bridge === null) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ocr-models-shell-unavailable">
        {t("ocr.modelStatus.shellUnavailable")}
      </p>
    )
  }
  return (
    <LocalModelManager
      backend={providerId}
      bridge={bridge}
      modelVariant={providerId === "paddle-ocr" ? modelVariant : undefined}
    />
  )
}

/* ─────────────────────────── LocalModelManager ─────────────────────────── */

interface LocalModelManagerProps {
  backend: string
  bridge?: OcrModelBridge
  modelVariant?: PaddleModelVariant
}

/**
 * UI for the per-backend model-management row. Calls into the Rust
 * `ocr_model_status` and `ocr_download_model` commands via the supplied
 * bridge (Tauri in production, a stub in tests).
 */
export function LocalModelManager(props: LocalModelManagerProps): React.ReactElement {
  const t = useTranslations()
  const [bridge] = useState<OcrModelBridge | null>(() => props.bridge ?? buildTauriModelBridge())
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null)
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)

  // Fetch initial status. Re-fetched after every download attempt.
  const refresh = useCallback(async () => {
    if (!bridge) return
    try {
      const s = await bridge.status(props.backend, props.modelVariant)
      setStatus(s)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [bridge, props.backend, props.modelVariant])

  useEffect(() => {
    // Initial mount-time fetch of model status. The setState inside
    // `refresh()` is exactly what the effect is here for — synchronizing
    // local state with the Rust-side status. `refresh` is stable across
    // re-renders (its closure only depends on `bridge` and `props.backend`).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!bridge) return
    const off = bridge.onProgress((event) => {
      if (event.backend === props.backend) {
        setProgress(event)
      }
    })
    return off
  }, [bridge, props.backend])

  const handleDownload = useCallback(async () => {
    if (!bridge) return
    if (downloading && activeRequestId) {
      await bridge.cancel?.(activeRequestId)
      return
    }
    const requestId = globalThis.crypto?.randomUUID?.() ?? `ocr-model-${Date.now()}`
    setDownloading(true)
    setActiveRequestId(requestId)
    setError(null)
    setProgress(null)
    try {
      const after = await bridge.download(props.backend, props.modelVariant, requestId)
      setStatus(after)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
      setActiveRequestId(null)
      setProgress(null)
    }
  }, [activeRequestId, bridge, downloading, props.backend, props.modelVariant])

  if (!bridge)
    return <p className="text-xs text-muted-foreground">{t("ocr.modelStatus.description")}</p>

  const missingCount = status ? status.files.filter((f) => !f.installed).length : 0
  const percent =
    progress && progress.bytes_total > 0
      ? Math.min(100, Math.round((progress.bytes_done / progress.bytes_total) * 100))
      : 0

  return (
    <div className="space-y-2" data-testid={`ocr-model-manager-${props.backend}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="text-sm">{t("ocr.modelStatus.title")}</Label>
          <p className="text-xs text-muted-foreground">{t("ocr.modelStatus.description")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleDownload()}
          aria-label={
            downloading ? t("ocr.modelStatus.cancelDownload") : t("ocr.modelStatus.download")
          }
        >
          {downloading
            ? t("ocr.modelStatus.cancelDownload")
            : status?.installed
              ? t("ocr.modelStatus.redownload")
              : t("ocr.modelStatus.download")}
        </Button>
      </div>
      {status?.legacy_files?.length ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t("ocr.modelStatus.legacyDetected", {
            count: status.legacy_files.length,
            path: status.legacy_model_dir ?? status.model_dir,
          })}
        </p>
      ) : status && status.reason ? (
        <p className="text-xs text-muted-foreground">{status.reason}</p>
      ) : status ? (
        <p className="text-xs text-muted-foreground">
          {status.installed
            ? t("ocr.modelStatus.downloadComplete", { bytes: status.total_bytes })
            : t("ocr.modelStatus.missing", { count: missingCount })}
        </p>
      ) : null}
      {status?.model_dir && (
        <p className="break-all text-xs text-muted-foreground">
          {t("ocr.modelStatus.modelDir", { path: status.model_dir })}
        </p>
      )}
      {downloading && progress && (
        <div className="space-y-1">
          <p className="text-xs">
            {t("ocr.modelStatus.downloading", {
              file: progress.file_name,
              percent,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("ocr.modelStatus.downloadingDetail", {
              bytesDone: progress.bytes_done,
              bytesTotal: progress.bytes_total,
              index: progress.file_index,
              count: progress.file_count,
            })}
          </p>
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {t("ocr.modelStatus.downloadFailed", { message: error })}
        </p>
      )}
    </div>
  )
}

/**
 * Build a bridge backed by the real Tauri commands. Returns `null` when
 * the app is running in a non-Tauri shell (browser export / Capacitor)
 * where the Rust side isn't reachable — the parent then hides the row.
 */
export function buildTauriModelBridge(): OcrModelBridge | null {
  if (!isTauri()) return null
  // Late-import the Tauri SDK so the static export's tree-shaker can drop
  // it when the binding isn't reachable.
  type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  type ListenFn = <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>
  let invokeFnPromise: Promise<InvokeFn> | null = null
  let listenFnPromise: Promise<ListenFn> | null = null
  const getInvoke = (): Promise<InvokeFn> => {
    invokeFnPromise ??= import("@tauri-apps/api/core").then((m) => m.invoke as InvokeFn)
    return invokeFnPromise
  }
  const getListen = (): Promise<ListenFn> => {
    listenFnPromise ??= import("@tauri-apps/api/event").then((m) => m.listen as ListenFn)
    return listenFnPromise
  }
  return {
    async status(backend, variant) {
      const invoke = await getInvoke()
      return invoke<ModelStatus>("ocr_model_status", { backend, variant })
    },
    async download(backend, variant, requestId) {
      const invoke = await getInvoke()
      await invoke<unknown>("ocr_download_model", { backend, variant, requestId })
      return invoke<ModelStatus>("ocr_model_status", { backend, variant })
    },
    async cancel(requestId) {
      const invoke = await getInvoke()
      return invoke<boolean>("ocr_cancel_model_download", { requestId })
    },
    onProgress(handler) {
      let unlisten: (() => void) | null = null
      let detached = false
      void getListen().then(async (listen) => {
        const off = await listen<DownloadProgressEvent>("ocr://download-progress", (event) =>
          handler(event.payload)
        )
        if (detached) {
          off()
        } else {
          unlisten = off
        }
      })
      return () => {
        detached = true
        unlisten?.()
      }
    },
  }
}
