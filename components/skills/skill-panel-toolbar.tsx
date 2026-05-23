"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  FolderDownIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  UploadIcon,
} from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SkillDiscovery } from "./skill-discovery"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { pickAndReadFiles } from "@/lib/files/file-bridge"
import { isTauri } from "@/lib/tauri"
import { listSkills } from "@/lib/db/skills"
import { nameFromFilename, parseSkillMarkdown } from "@/lib/claude/skills-io"
import { scanClaudeSkills } from "@/lib/claude/ipc"
import { useSkillsStore } from "@/stores/skills"
import type { ImportStaging } from "@/stores/skills"
import { useSkillSync } from "@/hooks/skills"
import { exportSkillsToDirWithFeedback } from "@/lib/skills/export-toast"
import { loggers } from "@/lib/logging"

const SKILL_FILE_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown"] }]

export function SkillPanelToolbar() {
  const t = useTranslations("skills.toolbar")
  const tCommon = useTranslations("skills")
  const tToasts = useTranslations("skills.toasts")
  const tSync = useTranslations("skills.sync")
  const tDiscovery = useTranslations("skills.discovery")
  const [busy, setBusy] = useState(false)
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const openCreate = useSkillsStore((s) => s.openCreate)
  const setImportStaging = useSkillsStore((s) => s.setImportStaging)
  const sync = useSkillSync()

  const handleImportFromMarkdown = async () => {
    setBusy(true)
    try {
      const files = await pickAndReadFiles({
        filters: SKILL_FILE_FILTERS,
        multiple: true,
      })
      if (files.length === 0) return
      const drafts: ImportStaging["drafts"] = []
      const parseErrors: ImportStaging["parseErrors"] = []
      for (const file of files) {
        try {
          const fallback = nameFromFilename(file.name)
          const { draft } = parseSkillMarkdown(file.content, {
            fallbackName: fallback,
          })
          drafts.push(draft)
        } catch (err) {
          parseErrors.push({
            name: file.name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (drafts.length === 0) {
        toast.error(
          parseErrors.length > 0
            ? tToasts("importNoFilesParsed", { count: parseErrors.length })
            : tToasts("importNoSkills")
        )
        loggers.skills.warn("import.markdown none parsed", {
          attempted: files.length,
          errors: parseErrors.length,
        })
        return
      }
      setImportStaging({
        drafts,
        sourceLabel: `${files.length} markdown file(s)`,
        parseErrors,
      })
      loggers.skills.info("import.markdown staged", {
        drafts: drafts.length,
        errors: parseErrors.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.markdown failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromClaudeCode = async () => {
    if (!isTauri()) {
      toast.error(tToasts("importFromClaudeDesktopOnly"))
      return
    }
    setBusy(true)
    try {
      const discovered = await scanClaudeSkills()
      if (discovered.length === 0) {
        toast.info(tToasts("importNoSkillMd"))
        loggers.skills.info("import.claudeCode empty")
        return
      }
      const drafts: ImportStaging["drafts"] = []
      const parseErrors: ImportStaging["parseErrors"] = []
      for (const file of discovered) {
        try {
          const { draft } = parseSkillMarkdown(file.content, {
            fallbackName: file.dirName,
          })
          const tags = Array.from(new Set([...(draft.tags ?? []), "claude-code"]))
          drafts.push({ ...draft, tags })
        } catch (err) {
          parseErrors.push({
            name: file.dirName,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (drafts.length === 0) {
        toast.error(
          tToasts("importNoneParsed", {
            found: discovered.length,
            first: parseErrors[0]?.error ?? "",
          })
        )
        loggers.skills.warn("import.claudeCode none parsed", {
          found: discovered.length,
          errors: parseErrors.length,
        })
        return
      }
      setImportStaging({
        drafts,
        sourceLabel: "~/.claude/skills/",
        parseErrors,
      })
      loggers.skills.info("import.claudeCode staged", {
        drafts: drafts.length,
        errors: parseErrors.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.claudeCode failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleExportAll = async () => {
    setBusy(true)
    try {
      const all = await listSkills()
      const customSkills = all.filter((s) => !s.isBuiltIn)
      await exportSkillsToDirWithFeedback(customSkills, tToasts, {
        source: "exportAll",
        total: customSkills.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("export all failed", err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" onClick={openCreate} disabled={busy}>
        <PlusIcon className="size-3.5 sm:mr-1.5" />
        <span className="hidden sm:inline">{t("new")}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={busy}>
            <UploadIcon className="size-3.5 sm:mr-1.5" />
            <span className="hidden sm:inline">{t("import")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onSelect={() => void handleImportFromMarkdown()} className="text-xs">
            <UploadIcon className="mr-2 size-3.5" />
            <div className="flex flex-col gap-0.5">
              <span>{t("importFromMarkdown")}</span>
              <span className="text-[10px] text-muted-foreground">
                {t("importFromMarkdownHint")}
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void handleImportFromClaudeCode()}
            disabled={!isTauri()}
            className="text-xs"
          >
            <SparklesIcon className="mr-2 size-3.5" />
            <div className="flex flex-col gap-0.5">
              <span>{t("importFromClaudeCode")}</span>
              <span className="text-[10px] text-muted-foreground">
                {t("importFromClaudeCodeHint")}
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setDiscoveryOpen(true)}
            disabled={!isTauri()}
            className="text-xs"
          >
            <SearchIcon className="mr-2 size-3.5" />
            <div className="flex flex-col gap-0.5">
              <span>{tDiscovery("title")}</span>
              <span className="text-[10px] text-muted-foreground">{tDiscovery("scanCustom")}</span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Export + Sync visible inline at md+ */}
      <Button
        size="sm"
        variant="outline"
        onClick={() => void handleExportAll()}
        disabled={busy}
        className="hidden md:inline-flex"
      >
        <FolderDownIcon className="mr-1.5 size-3.5" />
        {t("exportAll")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={!isTauri() || busy || sync.busy}
            title={!isTauri() ? t("syncNativeDesktopOnly") : t("syncNative")}
            className="hidden md:inline-flex"
          >
            <RefreshCwIcon className="mr-1.5 size-3.5" />
            {tCommon("syncLabel")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => void sync.push()} className="text-xs">
            <RefreshCwIcon className="mr-2 size-3.5" />
            {tSync("pushAll")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void sync.pull()} className="text-xs">
            <RefreshCwIcon className="mr-2 size-3.5 -scale-x-100" />
            {tSync("pullAll")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Below md, Export + Sync collapse into a single overflow menu. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 md:hidden"
            disabled={busy}
            aria-label={t("moreActions")}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onSelect={() => void handleExportAll()}
            disabled={busy}
            className="text-xs"
          >
            <FolderDownIcon className="mr-2 size-3.5" />
            {t("exportAll")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void sync.push()}
            disabled={!isTauri() || sync.busy}
            className="text-xs"
          >
            <RefreshCwIcon className="mr-2 size-3.5" />
            {tSync("pushAll")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void sync.pull()}
            disabled={!isTauri() || sync.busy}
            className="text-xs"
          >
            <RefreshCwIcon className="mr-2 size-3.5 -scale-x-100" />
            {tSync("pullAll")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Sheet open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-5 py-3">
            <SheetTitle>{tDiscovery("title")}</SheetTitle>
            <SheetDescription>
              {tDiscovery("scanHome")} · {tDiscovery("scanCustom")}
            </SheetDescription>
          </SheetHeader>
          <SkillDiscovery />
        </SheetContent>
      </Sheet>
    </div>
  )
}
