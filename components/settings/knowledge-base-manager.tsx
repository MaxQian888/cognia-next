"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon, Trash2Icon, UploadIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { RetrievalControlPanel } from "@/components/rag/retrieval-control-panel"
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
import { Textarea } from "@/components/ui/textarea"
import {
  createKnowledgeBaseSource,
  listKnowledgeBaseIngestJobs,
  listKnowledgeBaseSources,
} from "@/lib/db/knowledge-bases"
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"
import { tryBuildProjectKnowledgeDeps } from "@/lib/project-knowledge/runtime/build-deps"
import {
  BINARY_TWIN_FORMATS,
  detectSourceFormat,
  dispatchSource,
  listSupportedExtensions,
  listSupportedFormats,
} from "@/lib/twin/ingest"
import {
  ingestKnowledgeBaseSource,
  rebuildKnowledgeBaseIndex,
  removeKnowledgeBaseSource,
} from "@/lib/knowledge-base/ingest/ingest-source"
import type {
  KnowledgeBase,
  KnowledgeBaseIngestJob,
  KnowledgeBaseSource,
} from "@/types/knowledge-base"
import type { TwinSourceFormat } from "@/types/twin"

const SUPPORTED_FILE_FORMATS = listSupportedFormats().filter(
  (item): item is TwinSourceFormat => item !== "git-repo"
)

const FILE_PICKER_ACCEPT = listSupportedExtensions()
  .map((extension) => `.${extension}`)
  .join(",")

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return globalThis.btoa(binary)
}

export function KnowledgeBaseManager({ knowledgeBases }: { knowledgeBases: KnowledgeBase[] }) {
  const t = useTranslations("settings.characters.knowledgeBases.sources")
  const [selectedId, setSelectedId] = useState(knowledgeBases[0]?.id ?? "")
  const [sources, setSources] = useState<KnowledgeBaseSource[]>([])
  const [jobs, setJobs] = useState<KnowledgeBaseIngestJob[]>([])
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useState<"auto" | TwinSourceFormat>("auto")
  const [busy, setBusy] = useState(false)
  const activeSelectedId = knowledgeBases.some((item) => item.id === selectedId)
    ? selectedId
    : (knowledgeBases[0]?.id ?? "")

  const load = useCallback(async () => {
    if (!activeSelectedId) {
      setSources([])
      setJobs([])
      return
    }
    const [nextSources, nextJobs] = await Promise.all([
      listKnowledgeBaseSources(activeSelectedId),
      listKnowledgeBaseIngestJobs(activeSelectedId),
    ])
    setSources(nextSources)
    setJobs(nextJobs)
  }, [activeSelectedId])

  useEffect(() => {
    let cancelled = false
    const request = activeSelectedId
      ? Promise.all([
          listKnowledgeBaseSources(activeSelectedId),
          listKnowledgeBaseIngestJobs(activeSelectedId),
        ])
      : Promise.resolve<[KnowledgeBaseSource[], KnowledgeBaseIngestJob[]]>([[], []])
    void request.then(
      ([nextSources, nextJobs]) => {
        if (cancelled) return
        setSources(nextSources)
        setJobs(nextJobs)
      },
      () => {
        if (cancelled) return
        setSources([])
        setJobs([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [activeSelectedId])

  const latestJobBySource = useMemo(() => {
    const result = new Map<string, KnowledgeBaseIngestJob>()
    for (const job of jobs) if (!result.has(job.sourceId)) result.set(job.sourceId, job)
    return result
  }, [jobs])

  const ingest = async (sourceId: string) => {
    const deps = await tryBuildProjectKnowledgeDeps()
    if (!deps) {
      throw new Error(t("backendUnavailable"))
    }
    await ingestKnowledgeBaseSource({ sourceId, deps })
  }

  const addManualSource = async () => {
    const sourceTitle = title.trim()
    const sourceContent = content.trim()
    if (!activeSelectedId || !sourceTitle || !sourceContent) return
    setBusy(true)
    try {
      const source = await createKnowledgeBaseSource({
        knowledgeBaseId: activeSelectedId,
        kind: "document",
        format: "markdown",
        title: sourceTitle,
        content: sourceContent,
        fingerprint: `djb2:${hashContent(sourceContent)}`,
      })
      setTitle("")
      setContent("")
      await ingest(source.id)
      toast.success(t("imported", { name: source.title }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      await load()
      setBusy(false)
    }
  }

  const importFile = async () => {
    if (!activeSelectedId || !file) return
    const resolvedFormat = format === "auto" ? detectSourceFormat(file.name) : format
    if (!resolvedFormat) {
      toast.error(t("unsupportedFormat"))
      return
    }
    setBusy(true)
    try {
      const binary = BINARY_TWIN_FORMATS.has(resolvedFormat)
      const sourceContent = binary ? encodeBase64(await file.arrayBuffer()) : await file.text()
      const source = await createKnowledgeBaseSource({
        knowledgeBaseId: activeSelectedId,
        kind: dispatchSource(resolvedFormat).kind,
        format: resolvedFormat,
        title: file.name,
        content: sourceContent,
        contentEncoding: binary ? "base64" : "utf8",
        originalLocation: file.name,
        bytes: file.size,
        fingerprint: `djb2:${hashContent(sourceContent)}`,
      })
      setFile(null)
      await ingest(source.id)
      toast.success(t("imported", { name: source.title }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      await load()
      setBusy(false)
    }
  }

  const retry = async (source: KnowledgeBaseSource) => {
    setBusy(true)
    try {
      if (source.errorCode === "embedding_dimension_mismatch") {
        const deps = await tryBuildProjectKnowledgeDeps()
        if (!deps) throw new Error(t("backendUnavailable"))
        const result = await rebuildKnowledgeBaseIndex(source.knowledgeBaseId, deps)
        if (result.failedSourceIds.length > 0) {
          throw new Error(t("rebuildPartial", { count: result.failedSourceIds.length }))
        }
      } else {
        await ingest(source.id)
      }
      toast.success(t("reindexed"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      await load()
      setBusy(false)
    }
  }

  const remove = async (sourceId: string) => {
    setBusy(true)
    try {
      const deps = await tryBuildProjectKnowledgeDeps()
      await removeKnowledgeBaseSource(sourceId, deps)
      toast.success(t("removed"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      await load()
      setBusy(false)
    }
  }

  if (knowledgeBases.length === 0) return null

  return (
    <div className="space-y-3 border-t pt-3">
      <RetrievalControlPanel corpusPrefixes={[`knowledge_base:${activeSelectedId}:`]} compact />
      <div className="space-y-1">
        <Label>{t("library")}</Label>
        <Select value={activeSelectedId} onValueChange={setSelectedId}>
          <SelectTrigger aria-label={t("library")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {knowledgeBases.map((knowledgeBase) => (
              <SelectItem key={knowledgeBase.id} value={knowledgeBase.id}>
                {knowledgeBase.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("titlePlaceholder")}
          aria-label={t("sourceTitle")}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || !title.trim() || !content.trim()}
          onClick={() => void addManualSource()}
        >
          {t("addText")}
        </Button>
        <Textarea
          className="min-h-24 sm:col-span-2"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={t("contentPlaceholder")}
          aria-label={t("sourceContent")}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input
          type="file"
          accept={FILE_PICKER_ACCEPT}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          aria-label={t("file")}
        />
        <Select value={format} onValueChange={(value) => setFormat(value as typeof format)}>
          <SelectTrigger aria-label={t("format")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("formatAuto")}</SelectItem>
            {SUPPORTED_FILE_FORMATS.map((item) => (
              <SelectItem key={item} value={item}>
                {t(`formats.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" disabled={busy || !file} onClick={() => void importFile()}>
          <UploadIcon className="mr-1 size-3.5" />
          {t("importFile")}
        </Button>
      </div>

      {sources.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="space-y-1.5">
          {sources.map((source) => {
            const job = latestJobBySource.get(source.id)
            return (
              <div
                key={source.id}
                className="flex flex-col gap-2 rounded-md border px-2 py-2 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate text-xs font-medium">{source.title}</p>
                    <Badge variant="outline">{t(`status.${source.status}`)}</Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {t("chunkCount", { count: source.chunkCount })}
                    </span>
                  </div>
                  {source.errorCode && (
                    <p className="text-[10px] text-destructive">
                      {source.errorCode === "embedding_dimension_mismatch"
                        ? t("rebuildRequired")
                        : t("failed")}
                    </p>
                  )}
                  {job && (job.status === "queued" || job.status === "running") && (
                    <p className="text-[10px] text-muted-foreground">
                      {t("progress", {
                        phase: t(`phases.${job.phase}`),
                        progress: job.progress,
                      })}
                    </p>
                  )}
                </div>
                <div className="flex w-full justify-end gap-1 sm:w-auto">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void retry(source)}
                  >
                    <RefreshCwIcon className="mr-1 size-3.5" />
                    {source.errorCode === "embedding_dimension_mismatch"
                      ? t("rebuild")
                      : t("retry")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    onClick={() => void remove(source.id)}
                    aria-label={t("removeAria", { name: source.title })}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
