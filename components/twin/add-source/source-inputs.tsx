"use client"

/**
 * Input panels for the add-source flow — one per source type.
 *
 * Each panel gathers its parameters and runs the matching staging function
 * from `lib/twin/ingest/stage` (extract WITHOUT committing), then hands the
 * staged items up to the flow via `onStaged`. Structured failures go up as
 * `IngestError` so the flow renders one localized banner for every type.
 */

import { useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { isTauri } from "@/lib/tauri"
import {
  BINARY_TWIN_FORMATS,
  listSupportedExtensions,
  listSupportedFormats,
} from "@/lib/twin/ingest"
import {
  stageFile,
  stageGitRepo,
  stageLarkDoc,
  stagePaste,
  stageUrl,
  type IngestError,
  type StagedSource,
} from "@/lib/twin/ingest/stage"
import { parseLarkDocUrl } from "@/lib/twin/ingest/lark-url"
import { LarkAccountPicker } from "../lark-account-picker"
import type { TwinSourceFormat } from "@/types/twin"

// `isTauri()` reads `window.__TAURI_INTERNALS__`. Use `useSyncExternalStore`
// so SSR returns `false` and the client reads the real value on first paint.
const subscribeTauri = (): (() => void) => () => {}
const getTauriSnapshot = (): boolean => isTauri()
const getServerTauriSnapshot = (): boolean => false

export function useTauriAvailable(): boolean {
  return useSyncExternalStore(subscribeTauri, getTauriSnapshot, getServerTauriSnapshot)
}

const FILE_PICKER_ACCEPT = listSupportedExtensions()
  .map((ext) => `.${ext}`)
  .join(",")

const FORMATS: TwinSourceFormat[] = listSupportedFormats() as TwinSourceFormat[]
const PASTE_FORMATS = FORMATS.filter(
  (format) => format !== "git-repo" && !BINARY_TWIN_FORMATS.has(format)
)

/** Per-file diagnostic emitted alongside the staged batch. */
export interface FileNotice {
  filename: string
  staged: number
  error?: IngestError
}

export interface SourceInputProps {
  twinId: string
  busy: boolean
  setBusy: (busy: boolean) => void
  onStaged: (staged: StagedSource[], notices?: FileNotice[]) => void
  onError: (error: IngestError) => void
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function FileSourceInput({ twinId, busy, setBusy, onStaged, onError }: SourceInputProps) {
  const t = useTranslations("twin.sourceUploader")

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    try {
      const staged: StagedSource[] = []
      const notices: FileNotice[] = []
      for (const file of Array.from(files)) {
        try {
          const result = await stageFile(file, twinId)
          staged.push(...result.staged)
          notices.push({ filename: file.name, staged: result.staged.length, error: result.error })
        } catch (err) {
          notices.push({
            filename: file.name,
            staged: 0,
            error: {
              code: "parseFailed",
              params: { message: err instanceof Error ? err.message : String(err) },
            },
          })
        }
      }
      if (staged.length === 0) {
        onError(notices.find((n) => n.error)?.error ?? { code: "fileEmpty" })
      } else {
        onStaged(staged, notices)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="twin-add-source-file">
      <p className="text-muted-foreground text-xs">{t("filesDescription")}</p>
      <input
        type="file"
        multiple
        accept={FILE_PICKER_ACCEPT}
        disabled={busy}
        onChange={(e) => void handleFiles(e.target.files)}
        className="text-sm"
        aria-label={t("pickFilesAria")}
      />
      {busy ? (
        <Loader2Icon className="text-muted-foreground size-4 animate-spin" aria-hidden />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Web URL
// ---------------------------------------------------------------------------

export interface UrlSourceInputProps extends SourceInputProps {
  /** Called when the entered URL is actually a Feishu/Lark doc link. */
  onSwitchToLark?: (url: string) => void
}

export function UrlSourceInput({
  busy,
  setBusy,
  onStaged,
  onError,
  onSwitchToLark,
}: UrlSourceInputProps) {
  const t = useTranslations("twin.sourceUploader")
  const tLark = useTranslations("twin.sourceUploader.lark")
  const tAdd = useTranslations("twin.addSource")
  const [url, setUrl] = useState("")
  const tauriAvailable = useTauriAvailable()

  const larkRef = parseLarkDocUrl(url)

  const handleSubmit = async () => {
    setBusy(true)
    try {
      let fetchImpl: typeof fetch | undefined
      if (tauriAvailable) {
        const { createProxyFetch } = await import("@/lib/network/proxy-fetch")
        fetchImpl = createProxyFetch() as typeof fetch
      }
      const result = await stageUrl(url, {
        ...(fetchImpl ? { fetchImpl } : {}),
        jinaFallback: tauriAvailable,
      })
      if (result.error) onError(result.error)
      else onStaged(result.staged)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="twin-add-source-url">
      <p className="text-muted-foreground text-xs">{t("urlDescription")}</p>
      {!tauriAvailable ? <p className="text-muted-foreground text-xs">{t("webModeHint")}</p> : null}
      <div className="flex flex-col gap-2 @sm/twin-add:flex-row @sm/twin-add:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="twin-add-source-url-input">{t("urlLabel")}</Label>
          <Input
            id="twin-add-source-url-input"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("urlPlaceholder")}
            disabled={busy}
          />
        </div>
        <Button
          onClick={() => void handleSubmit()}
          disabled={busy || larkRef !== null}
          data-testid="twin-add-source-url-fetch"
        >
          {busy ? (
            <>
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              {t("fetching")}
            </>
          ) : (
            tAdd("extract")
          )}
        </Button>
      </div>
      {larkRef && onSwitchToLark ? (
        <p className="text-xs" data-testid="twin-add-source-url-lark-hint">
          {larkRef.kind === "wiki" ? tLark("detectedWiki") : tLark("detectedDoc")}{" "}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => onSwitchToLark(url)}
            data-testid="twin-add-source-url-switch-lark"
          >
            {tAdd("switchToLark")}
          </Button>
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Feishu / Lark doc
// ---------------------------------------------------------------------------

export interface LarkSourceInputProps extends SourceInputProps {
  /** Prefill from the URL panel's "switch to Lark" hand-off. */
  initialUrl?: string
}

export function LarkSourceInput({
  busy,
  setBusy,
  onStaged,
  onError,
  initialUrl,
}: LarkSourceInputProps) {
  const tLark = useTranslations("twin.sourceUploader.lark")
  const tAdd = useTranslations("twin.addSource")
  const [url, setUrl] = useState(initialUrl ?? "")
  const [adapterId, setAdapterId] = useState<string | null>(null)
  const tauriAvailable = useTauriAvailable()

  const handleSubmit = async () => {
    if (!adapterId) {
      onError({ code: "larkNoAccount" })
      return
    }
    setBusy(true)
    try {
      const result = await stageLarkDoc(url.trim(), { adapterId })
      if (result.error) onError(result.error)
      else onStaged(result.staged)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="twin-add-source-lark">
      <p className="text-muted-foreground text-xs">{tLark("sectionDescription")}</p>
      {!tauriAvailable ? (
        <p className="text-destructive text-xs" data-testid="twin-add-source-lark-browser-hint">
          {tLark("browserModeHint")}
        </p>
      ) : null}
      <LarkAccountPicker value={adapterId} onChange={setAdapterId} disabled={busy} />
      <div className="flex flex-col gap-2 @sm/twin-add:flex-row @sm/twin-add:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="twin-add-source-lark-url">{tLark("urlLabel")}</Label>
          <Input
            id="twin-add-source-lark-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={tLark("urlPlaceholder")}
            disabled={busy}
          />
        </div>
        <Button
          onClick={() => void handleSubmit()}
          disabled={busy || !url.trim()}
          data-testid="twin-add-source-lark-fetch"
        >
          {busy ? (
            <>
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              {tAdd("extracting")}
            </>
          ) : (
            tAdd("extract")
          )}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Paste text
// ---------------------------------------------------------------------------

export function PasteSourceInput({ busy, onStaged, onError }: SourceInputProps) {
  const t = useTranslations("twin.sourceUploader")
  const tAdd = useTranslations("twin.addSource")
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [format, setFormat] = useState<TwinSourceFormat>("markdown")

  const handleSubmit = () => {
    const result = stagePaste({ content, format, title })
    if (result.error) onError(result.error)
    else onStaged(result.staged)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="twin-add-source-paste">
      <div className="flex flex-col gap-2 @sm/twin-add:flex-row @sm/twin-add:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="twin-add-source-title">{t("titleLabel")}</Label>
          <Input
            id="twin-add-source-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("titlePlaceholder")}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="twin-add-source-format">{t("formatLabel")}</Label>
          <Select value={format} onValueChange={(next) => setFormat(next as TwinSourceFormat)}>
            <SelectTrigger
              id="twin-add-source-format"
              className="w-[12rem]"
              aria-label={t("formatLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PASTE_FORMATS.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="twin-add-source-content">{t("contentLabel")}</Label>
        <Textarea
          id="twin-add-source-content"
          rows={8}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t("contentPlaceholder")}
        />
      </div>
      <div className="flex justify-end">
        <Button onClick={handleSubmit} disabled={busy} data-testid="twin-add-source-paste-stage">
          {tAdd("extract")}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Git repository (Tauri only)
// ---------------------------------------------------------------------------

export function GitSourceInput({ twinId, busy, setBusy, onStaged, onError }: SourceInputProps) {
  const t = useTranslations("twin.sourceUploader")
  const [maxCommits, setMaxCommits] = useState(200)
  const [author, setAuthor] = useState("")

  const handlePick = async () => {
    setBusy(true)
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({ directory: true, multiple: false })
      if (!picked || typeof picked !== "string") return
      const result = await stageGitRepo({
        twinId,
        repoPath: picked,
        maxCommits,
        author,
      })
      if (result.error) onError(result.error)
      else onStaged(result.staged)
    } catch (err) {
      onError({
        code: "gitWalkFailed",
        params: { reason: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="twin-add-source-git">
      <p className="text-muted-foreground text-xs">{t("gitRepoDescription")}</p>
      <div className="flex flex-col gap-2 @sm/twin-add:flex-row @sm/twin-add:items-end">
        <div className="flex flex-col gap-1">
          <Label htmlFor="twin-add-source-max-commits">{t("maxCommits")}</Label>
          <Input
            id="twin-add-source-max-commits"
            type="number"
            min={1}
            max={2000}
            value={maxCommits}
            onChange={(e) => setMaxCommits(Number.parseInt(e.target.value, 10) || 200)}
            className="w-32"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="twin-add-source-author">{t("authorFilter")}</Label>
          <Input
            id="twin-add-source-author"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder={t("authorPlaceholder")}
          />
        </div>
        <Button
          onClick={() => void handlePick()}
          disabled={busy}
          data-testid="twin-add-source-git-pick"
        >
          {busy ? (
            <>
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              {t("walking")}
            </>
          ) : (
            t("pickRepoFolder")
          )}
        </Button>
      </div>
    </div>
  )
}
