"use client"

/**
 * OCR settings — entry component rendered from `settings-shell.tsx` when the
 * `ocr` section is active. Mirrors the layout used by `components/settings/
 * search/` (left list of providers, right detail pane), but lighter — OCR
 * config is much smaller per provider than the main LLM-provider system.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  type OcrProviderCategory,
  DEFAULT_OCR_SETTINGS,
  type UserOcrSettings,
} from "@/lib/ocr/types"

const PROVIDER_LIST: Array<{
  id: string
  category: OcrProviderCategory
}> = [
  { id: "mistral-ocr", category: "document-cloud" },
  { id: "google-vision", category: "document-cloud" },
  { id: "aws-textract", category: "document-cloud" },
  { id: "azure-document-intelligence", category: "document-cloud" },
  { id: "anthropic-vision", category: "llm-vision" },
  { id: "openai-vision", category: "llm-vision" },
  { id: "gemini-vision", category: "llm-vision" },
  { id: "mathpix", category: "specialist" },
  { id: "ocr-space", category: "specialist" },
  { id: "abbyy-cloud", category: "specialist" },
  { id: "nanonets", category: "specialist" },
  { id: "lark-basic", category: "lark" },
  { id: "tesseract-wasm", category: "local" },
  { id: "tesseract-native", category: "local" },
  { id: "windows-media-ocr", category: "local" },
  { id: "apple-vision", category: "local" },
  { id: "mlkit-android", category: "local" },
  { id: "ocrs", category: "local" },
  { id: "paddle-ocr", category: "local" },
  { id: "local-http", category: "local" },
]

/** Backends that ship their own downloaded model files. */
const BACKENDS_WITH_MANAGED_MODELS = new Set<string>(["ocrs", "paddle-ocr"])

export interface ModelFileStatus {
  file_name: string
  installed: boolean
  expected_bytes: number
  actual_bytes?: number
}

export interface ModelStatus {
  backend: string
  installed: boolean
  model_dir: string
  files: ModelFileStatus[]
  total_bytes: number
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
 * Tauri-backed bridge for the local model manager. Injected so the test
 * suite can drive the UI without spinning up a Tauri runtime.
 */
export interface OcrModelBridge {
  status(backend: string): Promise<ModelStatus>
  download(backend: string): Promise<ModelStatus>
  /** Subscribe to download-progress events. Returns an unsubscribe fn. */
  onProgress(handler: (event: DownloadProgressEvent) => void): () => void
}

export interface OcrSectionProps {
  settings?: UserOcrSettings
  onChange?: (next: UserOcrSettings) => void
  onClearCache?: () => Promise<void> | void
  onClearProviderCache?: (providerId: string) => Promise<void> | void
  /**
   * Bridge to the Rust-side model manager. When omitted the page tries to
   * build one from Tauri's `invoke` / `listen`; tests pass a stub directly.
   * Pass `null` to suppress the model row entirely (e.g. on the browser
   * shell where these backends can't run).
   */
  modelBridge?: OcrModelBridge | null
}

export function OcrSection(props: OcrSectionProps): React.ReactElement {
  const t = useTranslations()
  const [settings, setSettings] = useState<UserOcrSettings>(props.settings ?? DEFAULT_OCR_SETTINGS)
  const [selectedId, setSelectedId] = useState<string>(PROVIDER_LIST[0]!.id)

  const handleChange = useCallback(
    (next: UserOcrSettings) => {
      setSettings(next)
      props.onChange?.(next)
    },
    [props]
  )

  const grouped = useMemo(() => groupByCategory(PROVIDER_LIST), [])

  return (
    <div className="space-y-6" data-testid="ocr-section">
      <header>
        <h1 className="text-2xl font-semibold">{t("settings.tabs.ocr")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.descriptions.ocr")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("ocr.defaults.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ocr-default-provider">{t("ocr.defaults.defaultProvider")}</Label>
              <Select
                value={settings.defaultProviderId}
                onValueChange={(v) =>
                  handleChange({
                    ...settings,
                    defaultProviderId: v as UserOcrSettings["defaultProviderId"],
                  })
                }
              >
                <SelectTrigger id="ocr-default-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("ocr.defaults.auto")}</SelectItem>
                  {PROVIDER_LIST.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {t(`ocr.providers.${p.id}.label`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ocr-format">{t("ocr.params.format.label")}</Label>
              <Select
                value={settings.defaultFormat}
                onValueChange={(v) =>
                  handleChange({
                    ...settings,
                    defaultFormat: v as UserOcrSettings["defaultFormat"],
                  })
                }
              >
                <SelectTrigger id="ocr-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="markdown">{t("ocr.params.format.markdown")}</SelectItem>
                  <SelectItem value="text">{t("ocr.params.format.text")}</SelectItem>
                  <SelectItem value="blocks">{t("ocr.params.format.blocks")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ocr-langs">{t("ocr.params.languages.label")}</Label>
              <Input
                id="ocr-langs"
                value={settings.defaultLanguages.join(",")}
                onChange={(e) =>
                  handleChange({
                    ...settings,
                    defaultLanguages: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ocr-max-dim">{t("ocr.params.maxImageDimension.label")}</Label>
              <Input
                id="ocr-max-dim"
                type="number"
                min={256}
                max={8192}
                step={64}
                value={settings.maxImageDimension}
                onChange={(e) =>
                  handleChange({
                    ...settings,
                    maxImageDimension: Number(e.target.value) || settings.maxImageDimension,
                  })
                }
              />
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">{t("ocr.defaults.cloudFallback")}</Label>
              <p className="text-xs text-muted-foreground">{t("ocr.defaults.cloudFallbackHint")}</p>
            </div>
            <Switch
              checked={settings.cloudFallbackEnabled}
              onCheckedChange={(checked) =>
                handleChange({ ...settings, cloudFallbackEnabled: checked })
              }
              aria-label={t("ocr.defaults.cloudFallback")}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">{t("ocr.defaults.pdfFastPath")}</Label>
              <p className="text-xs text-muted-foreground">{t("ocr.defaults.pdfFastPathHint")}</p>
            </div>
            <Switch
              checked={settings.pdfTextLayerFastPath}
              onCheckedChange={(checked) =>
                handleChange({ ...settings, pdfTextLayerFastPath: checked })
              }
              aria-label={t("ocr.defaults.pdfFastPath")}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>{t("ocr.providers.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(Object.entries(grouped) as Array<[OcrProviderCategory, typeof PROVIDER_LIST]>).map(
              ([category, providers]) => (
                <div key={category} className="space-y-1">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t(`ocr.categories.${category}`)}
                  </p>
                  <ul role="list" className="space-y-1">
                    {providers.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${selectedId === p.id ? "bg-muted font-medium" : ""}`}
                          onClick={() => setSelectedId(p.id)}
                          aria-current={selectedId === p.id ? "true" : undefined}
                        >
                          {t(`ocr.providers.${p.id}.label`)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
          </CardContent>
        </Card>

        <Card data-testid="ocr-provider-detail">
          <CardHeader>
            <CardTitle>{t(`ocr.providers.${selectedId}.label`)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t(`ocr.providers.${selectedId}.description`)}
            </p>
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t("ocr.providers.enabled")}</Label>
              <Switch
                checked={settings.providerEnabled[selectedId] !== false}
                onCheckedChange={(checked) =>
                  handleChange({
                    ...settings,
                    providerEnabled: { ...settings.providerEnabled, [selectedId]: checked },
                  })
                }
                aria-label={`${t("ocr.providers.enabled")} (${selectedId})`}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void props.onClearProviderCache?.(selectedId)}
            >
              {t("ocr.cache.clearProvider")}
            </Button>

            {BACKENDS_WITH_MANAGED_MODELS.has(selectedId) && props.modelBridge !== null && (
              <>
                <Separator />
                <LocalModelManager backend={selectedId} bridge={props.modelBridge} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("ocr.cache.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <Button variant="outline" onClick={() => void props.onClearCache?.()}>
            {t("ocr.cache.clear")}
          </Button>
          <p className="text-sm text-muted-foreground">{t("ocr.cache.description")}</p>
        </CardContent>
      </Card>
    </div>
  )
}

function groupByCategory(
  list: typeof PROVIDER_LIST
): Record<OcrProviderCategory, typeof PROVIDER_LIST> {
  const out: Record<OcrProviderCategory, typeof PROVIDER_LIST> = {
    "document-cloud": [],
    "llm-vision": [],
    specialist: [],
    lark: [],
    local: [],
  }
  for (const p of list) {
    out[p.category].push(p)
  }
  return out
}

/**
 * UI for the per-backend model-management row. Calls into the Rust
 * `ocr_model_status` and `ocr_download_model` commands via the supplied
 * bridge (Tauri in production, a stub in tests).
 */
interface LocalModelManagerProps {
  backend: string
  bridge?: OcrModelBridge
}

export function LocalModelManager(props: LocalModelManagerProps): React.ReactElement {
  const t = useTranslations()
  const [bridge] = useState<OcrModelBridge | null>(() => props.bridge ?? buildTauriModelBridge())
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null)

  // Fetch initial status. Re-fetched after every download attempt.
  const refresh = useCallback(async () => {
    if (!bridge) return
    try {
      const s = await bridge.status(props.backend)
      setStatus(s)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [bridge, props.backend])

  useEffect(() => {
    // Initial mount-time fetch of model status. The setState inside
    // `refresh()` is exactly what the effect is here for — synchronizing
    // local state with the Rust-side status. Cascading-render concerns
    // don't apply because `refresh` is stable across re-renders (its
    // closure only depends on `bridge` and `props.backend`).
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
    setDownloading(true)
    setError(null)
    setProgress(null)
    try {
      const after = await bridge.download(props.backend)
      setStatus(after)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
      setProgress(null)
    }
  }, [bridge, props.backend])

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
          disabled={downloading}
          aria-label={t("ocr.modelStatus.download")}
        >
          {status?.installed ? t("ocr.modelStatus.redownload") : t("ocr.modelStatus.download")}
        </Button>
      </div>
      {status && status.reason ? (
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
function buildTauriModelBridge(): OcrModelBridge | null {
  if (typeof window === "undefined") return null
  if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return null
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
    async status(backend) {
      const invoke = await getInvoke()
      return invoke<ModelStatus>("ocr_model_status", { backend })
    },
    async download(backend) {
      const invoke = await getInvoke()
      await invoke<unknown>("ocr_download_model", { backend })
      return invoke<ModelStatus>("ocr_model_status", { backend })
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
