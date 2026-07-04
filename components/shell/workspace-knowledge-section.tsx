"use client"

import { useMemo, useRef, useState } from "react"
import type { ProjectKnowledgeIngestController } from "@/lib/project-knowledge/wire-ingest"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { FileTextIcon, RefreshCwIcon, Trash2Icon, UploadIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { StatusBadge } from "@/components/status-badge"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
import { getDb } from "@/lib/db/schema"
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"
import { createProjectKnowledgeIngestController } from "@/lib/project-knowledge/wire-ingest"
import { resolveProjectKnowledgeSettings } from "@/types/project-knowledge"
import type { KnowledgeFile, Project } from "@/types"

interface Props {
  project: Project
}

/** Map a filename extension to a `KnowledgeFile.type`. */
function typeForName(name: string): KnowledgeFile["type"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "md" || ext === "markdown") return "markdown"
  if (ext === "json") return "json"
  if (ext === "csv") return "csv"
  if (ext === "html" || ext === "htm") return "html"
  if (ext === "pdf") return "pdf"
  if (
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "rs",
      "go",
      "java",
      "c",
      "cpp",
      "h",
      "rb",
      "php",
      "sh",
    ].includes(ext)
  ) {
    return "code"
  }
  return "text"
}

/**
 * WorkspaceKnowledgeSection — manage a workspace's knowledge base (project-scoped
 * RAG). Lists each `KnowledgeFile` with a live ingest-status badge derived from
 * the `projectChunks` table, supports adding files (upload text-readable files or
 * paste text), removing, and manual reindex. Also exposes the per-project RAG
 * toggle + topK.
 */
export function WorkspaceKnowledgeSection({ project }: Props) {
  const t = useTranslations("workspace.manage.knowledge")
  const addKnowledgeFile = useProjectStore((s) => s.addKnowledgeFile)
  const removeKnowledgeFile = useProjectStore((s) => s.removeKnowledgeFile)
  const updateProject = useProjectStore((s) => s.updateProject)

  // Stable per-mount controller for manual reindex actions (lazy init so it's
  // created exactly once, without writing a ref during render).
  const [controller] = useState<ProjectKnowledgeIngestController>(() =>
    createProjectKnowledgeIngestController()
  )

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pasteName, setPasteName] = useState("")
  const [pasteText, setPasteText] = useState("")

  const settings = resolveProjectKnowledgeSettings(project.knowledgeSettings)
  const files = project.knowledgeBase ?? []

  // Live per-file chunk status: fileId → { count, contentHash }.
  const chunkStatus = useLiveQuery(async () => {
    const rows = await getDb().projectChunks.where("projectId").equals(project.id).toArray()
    const byFile = new Map<string, { count: number; contentHash: string }>()
    for (const r of rows) {
      const cur = byFile.get(r.fileId)
      if (cur) cur.count += 1
      else byFile.set(r.fileId, { count: 1, contentHash: r.contentHash })
    }
    return byFile
  }, [project.id])

  const statusFor = (file: KnowledgeFile): { value: string; count: number } => {
    const entry = chunkStatus?.get(file.id)
    if (!entry || entry.count === 0) return { value: "pending", count: 0 }
    if (entry.contentHash !== hashContent(file.content ?? "")) {
      return { value: "outdated", count: entry.count }
    }
    return { value: "indexed", count: entry.count }
  }

  const totalChunks = useMemo(
    () => Array.from(chunkStatus?.values() ?? []).reduce((sum, e) => sum + e.count, 0),
    [chunkStatus]
  )

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList) return
    for (const f of Array.from(fileList)) {
      const content = await f.text()
      addKnowledgeFile(project.id, {
        name: f.name,
        type: typeForName(f.name),
        content,
        size: content.length,
      })
    }
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const handlePaste = () => {
    const text = pasteText.trim()
    if (!text) return
    addKnowledgeFile(project.id, {
      name: pasteName.trim() || t("pastedDefaultName"),
      type: "text",
      content: text,
      size: text.length,
    })
    setPasteName("")
    setPasteText("")
  }

  const setEnabled = (enabled: boolean) => {
    updateProject(project.id, {
      knowledgeSettings: { ...project.knowledgeSettings, enableProjectRag: enabled },
    })
  }
  const setTopK = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return
    updateProject(project.id, {
      knowledgeSettings: { ...project.knowledgeSettings, ragTopK: Math.floor(value) },
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>{t("title")}</Label>
        {files.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1"
            onClick={() => void controller.reindexProject(project)}
          >
            <RefreshCwIcon className="size-3.5" />
            {t("reindexAll")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("summary", { files: files.length, chunks: totalChunks })}
      </p>

      {files.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label={t("listLabel")}>
          {files.map((file) => {
            const status = statusFor(file)
            return (
              <li
                key={file.id}
                className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
              >
                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t("chunkCount", { count: status.count })}
                </span>
                <StatusBadge
                  value={status.value}
                  labelNamespace="workspace.manage.knowledge.status"
                  className="shrink-0"
                />
                <button
                  type="button"
                  aria-label={t("reindex")}
                  onClick={() => void controller.reindexFile(project.id, file)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <RefreshCwIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t("removeFile")}
                  onClick={() => removeKnowledgeFile(project.id, file.id)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Add: upload text-readable files */}
      <div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="knowledge-file-input"
          onChange={(e) => void handleUpload(e.target.files)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full gap-1"
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadIcon className="size-4" />
          {t("addFile")}
        </Button>
      </div>

      {/* Add: paste text */}
      <div className="space-y-2 rounded-md border border-dashed p-2">
        <Input
          value={pasteName}
          placeholder={t("pasteNamePlaceholder")}
          aria-label={t("pasteNamePlaceholder")}
          onChange={(e) => setPasteName(e.target.value)}
          className="h-7 text-xs"
        />
        <Textarea
          value={pasteText}
          placeholder={t("pastePlaceholder")}
          aria-label={t("pastePlaceholder")}
          onChange={(e) => setPasteText(e.target.value)}
          className="min-h-16 text-xs"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full"
          disabled={!pasteText.trim()}
          onClick={handlePaste}
        >
          {t("pasteText")}
        </Button>
      </div>

      {/* Per-project RAG settings */}
      <div className={cn("flex items-center justify-between gap-2 pt-1")}>
        <Label htmlFor="project-rag-enable" className="text-xs font-normal text-muted-foreground">
          {t("enableRag")}
        </Label>
        <Switch
          id="project-rag-enable"
          checked={settings.enableProjectRag}
          onCheckedChange={setEnabled}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="project-rag-topk" className="text-xs font-normal text-muted-foreground">
          {t("topK")}
        </Label>
        <Input
          id="project-rag-topk"
          type="number"
          min={1}
          max={50}
          value={settings.ragTopK}
          onChange={(e) => setTopK(Number(e.target.value))}
          className="h-7 w-20 text-xs"
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{t("backendHint")}</p>
    </div>
  )
}

export default WorkspaceKnowledgeSection
