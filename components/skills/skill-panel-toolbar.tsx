"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  FolderDownIcon,
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
import { pickAndReadFiles, pickDirectory, saveFilesToDir } from "@/lib/file-bridge"
import { isTauri } from "@/lib/tauri"
import { listSkills } from "@/lib/db/skills"
import {
  nameFromFilename,
  parseSkillMarkdown,
  serializeSkill,
  skillFilename,
} from "@/lib/claude/skills-io"
import { scanClaudeSkills } from "@/lib/claude/ipc"
import { useSkillsStore } from "@/stores/skills-store"
import type { ImportStaging } from "@/stores/skills-store"
import { useSkillSync } from "@/hooks/use-skill-sync"

const SKILL_FILE_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown"] }]

export function SkillPanelToolbar() {
  const t = useTranslations("skills.toolbar")
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
            ? `Couldn't parse any of ${parseErrors.length} file(s).`
            : "No skills imported."
        )
        return
      }
      setImportStaging({
        drafts,
        sourceLabel: `${files.length} markdown file(s)`,
        parseErrors,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromClaudeCode = async () => {
    if (!isTauri()) {
      toast.error("Importing from ~/.claude/skills/ requires desktop mode.")
      return
    }
    setBusy(true)
    try {
      const discovered = await scanClaudeSkills()
      if (discovered.length === 0) {
        toast.info("No SKILL.md files found under ~/.claude/skills/.")
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
          `Found ${discovered.length} skill(s) but none parsed: ${parseErrors[0]?.error ?? "unknown error"}`
        )
        return
      }
      setImportStaging({
        drafts,
        sourceLabel: "~/.claude/skills/",
        parseErrors,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleExportAll = async () => {
    setBusy(true)
    try {
      const all = await listSkills()
      const customSkills = all.filter((s) => !s.isBuiltIn)
      if (customSkills.length === 0) {
        toast.info("No custom skills to export.")
        return
      }
      const dir = await pickDirectory()
      const files = customSkills.map((sk) => ({
        name: skillFilename(sk.name),
        content: serializeSkill(sk),
      }))
      const result = await saveFilesToDir(dir, files)
      if (result.errored.length > 0) {
        toast.warning(
          `Exported ${result.writtenCount}/${files.length} (${result.errored.length} failed).`
        )
      } else {
        toast.success(`Exported ${result.writtenCount} skill file(s).`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" onClick={openCreate} disabled={busy}>
        <PlusIcon className="mr-1.5 size-3.5" />
        {t("new")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={busy}>
            <UploadIcon className="mr-1.5 size-3.5" />
            {t("import")}
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
      <Button size="sm" variant="outline" onClick={() => void handleExportAll()} disabled={busy}>
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
          >
            <RefreshCwIcon className="mr-1.5 size-3.5" />
            Sync
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
