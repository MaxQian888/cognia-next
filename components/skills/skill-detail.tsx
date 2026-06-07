"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ArrowUpCircleIcon,
  CopyIcon,
  DownloadIcon,
  FileCode2Icon,
  PencilIcon,
  PowerIcon,
  Trash2Icon,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useSkillUpdate } from "@/hooks/skills"
import { duplicateSkill, inferCategory, inferSource, setSkillStatus } from "@/lib/db/skills"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { getCategoryMeta, getSourceMeta } from "@/lib/skills/categories"
import { useSkillsStore } from "@/stores/skills"
import { serializeSkill, skillFilename } from "@/lib/claude/skills-io"
import { saveFileAs } from "@/lib/files/file-bridge"
import { toast } from "sonner"
import type { Skill } from "@/lib/claude/types"
import { SkillResourceManager } from "./skill-resource-manager"
import { SkillSecurityScanner } from "./skill-security-scanner"
import { SkillValidationSection } from "./skill-validation-section"
import { SkillSyncSection } from "./skill-sync-section"
import { useSkillValidation } from "@/hooks/skills"
import { loggers } from "@/lib/logging"

interface Props {
  skill: Skill
}

export function SkillDetail({ skill }: Props) {
  const t = useTranslations("skills")
  const tDetail = useTranslations("skills.detail")
  const tToasts = useTranslations("skills.toasts")
  const category = getCategoryMeta(inferCategory(skill))
  const source = getSourceMeta(inferSource(skill))
  const Icon = category.icon
  const status = skill.status ?? "enabled"
  const openEdit = useSkillsStore((s) => s.openEdit)
  const setDeleteTarget = useSkillsStore((s) => s.setDeleteTarget)
  const openSkillInEditor = useSkillsStore((s) => s.openSkillInEditor)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)
  const closeDetail = useSkillsStore((s) => s.closeDetail)
  const resources = useLiveQuery(() => listResourcesForSkill(skill.id), [skill.id])
  useSkillValidation(skill.id)

  const handleDuplicate = async () => {
    try {
      const dup = await duplicateSkill(skill.id)
      toast.success(tToasts("duplicatedAs", { name: dup.name }))
      loggers.skills.info("duplicate ok", { sourceId: skill.id, newId: dup.id })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("duplicate failed", err, { skillId: skill.id })
    }
  }

  const handleExport = async () => {
    try {
      const ok = await saveFileAs({
        defaultName: skillFilename(skill.name),
        content: serializeSkill(skill),
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      })
      if (ok) {
        toast.success(tToasts("exportedSingle", { name: skill.name }))
        loggers.skills.info("export single ok", { skillId: skill.id })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("export single failed", err, { skillId: skill.id })
    }
  }

  const handleToggleStatus = async () => {
    await setSkillStatus(skill.id, status === "enabled" ? "disabled" : "enabled")
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-start gap-3 border-b px-4 py-3 sm:px-5 sm:py-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${category.color}`}
        >
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{skill.name}</h2>
          {skill.description && (
            <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant={source.badgeVariant} className="h-5 text-[10px]">
              {t(`source.${source.labelKey}` as never)}
            </Badge>
            <Badge variant="outline" className="h-5 text-[10px]">
              {t(`category.${category.labelKey}` as never)}
            </Badge>
            {status === "disabled" && (
              <Badge variant="secondary" className="h-5 text-[10px]">
                {t("status.disabled")}
              </Badge>
            )}
            {(skill.tags ?? []).map((tag) => (
              <Badge key={tag} variant="outline" className="h-5 text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto sm:flex-col sm:items-stretch">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openEdit(skill.id)}
            disabled={skill.isBuiltIn}
          >
            <PencilIcon className="mr-1.5 size-3.5" />
            {t("card.edit")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              openSkillInEditor(skill.id, skill.content)
              setActiveTab("editor")
              // On mobile the detail renders inside a full-screen Sheet that
              // would otherwise keep covering the editor tab.
              closeDetail()
            }}
            disabled={skill.isBuiltIn}
            data-testid="skill-open-in-editor"
          >
            <FileCode2Icon className="mr-1.5 size-3.5" />
            {t("card.openInEditor")}
          </Button>
          <div className="flex gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={() => void handleDuplicate()}
              aria-label={t("card.duplicate")}
            >
              <CopyIcon className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={() => void handleExport()}
              aria-label={t("card.export")}
            >
              <DownloadIcon className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={() => void handleToggleStatus()}
              aria-label={status === "enabled" ? t("card.disable") : t("card.enable")}
            >
              <PowerIcon className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-destructive hover:text-destructive"
              onClick={() => setDeleteTarget({ skillId: skill.id, name: skill.name })}
              disabled={skill.isBuiltIn}
              aria-label={t("card.delete")}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <Tabs defaultValue="overview" className="flex flex-1 flex-col overflow-hidden">
        <div className="mx-4 mt-2 overflow-x-auto sm:mx-5">
          <TabsList className="self-start">
            <TabsTrigger value="overview" className="whitespace-nowrap">
              {tDetail("tabOverview")}
            </TabsTrigger>
            <TabsTrigger value="content" className="whitespace-nowrap">
              {tDetail("tabContent")}
            </TabsTrigger>
            <TabsTrigger value="resources" className="whitespace-nowrap">
              {tDetail("tabResources")}
              {resources && resources.length > 0 && (
                <span className="ml-1 text-[10px] opacity-60">{resources.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="security" className="whitespace-nowrap">
              {tDetail("tabSecurity")}
            </TabsTrigger>
            <TabsTrigger value="validation" className="whitespace-nowrap">
              {tDetail("tabValidation")}
              {skill.validationErrors && skill.validationErrors.length > 0 && (
                <Badge variant="destructive" className="ml-1 h-4 px-1.5 text-[10px]">
                  {skill.validationErrors.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </div>
        <ScrollArea className="flex-1">
          <TabsContent value="overview" className="m-0 px-5 py-4">
            <OverviewSection skill={skill} />
          </TabsContent>
          <TabsContent value="content" className="m-0 px-5 py-4">
            <ContentSection skill={skill} />
          </TabsContent>
          <TabsContent value="resources" className="m-0 px-5 py-4">
            <SkillResourceManager skillId={skill.id} />
          </TabsContent>
          <TabsContent value="security" className="m-0 px-5 py-4">
            <SkillSecurityScanner skill={skill} />
          </TabsContent>
          <TabsContent value="validation" className="m-0 px-5 py-4">
            <SkillValidationSection errors={skill.validationErrors ?? []} />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  )
}

function OverviewSection({ skill }: { skill: Skill }) {
  const t = useTranslations("skills.detail")
  const formatTime = (ms?: number) => {
    if (!ms) return "—"
    return new Date(ms).toLocaleString()
  }
  return (
    <div className="space-y-4">
      <SkillUpdateBanner skill={skill} />
      <SkillSyncSection skill={skill} />
      <div className="grid gap-3 text-xs">
        <Row label={t("metaCategory")}>{skill.category ?? "—"}</Row>
        <Row label={t("metaSource")}>{skill.source ?? "—"}</Row>
        {skill.author && <Row label={t("metaAuthor")}>{skill.author}</Row>}
        {skill.version && <Row label={t("metaVersion")}>{skill.version}</Row>}
        {skill.license && <Row label={t("metaLicense")}>{skill.license}</Row>}
        <Row label={t("metaCreated")}>{formatTime(skill.createdAt)}</Row>
        <Row label={t("metaUpdated")}>{formatTime(skill.updatedAt)}</Row>
        <Row label={t("metaUsage", { count: skill.usageCount ?? 0 })}>
          {skill.lastUsedAt
            ? t("metaLastUsed", { when: new Date(skill.lastUsedAt).toLocaleString() })
            : "—"}
        </Row>
        {skill.allowedTools && skill.allowedTools.length > 0 && (
          <Row label={t("metaTools")}>
            <span className="font-mono">{skill.allowedTools.join(", ")}</span>
          </Row>
        )}
      </div>
    </div>
  )
}

/**
 * "Update available" banner with a one-click update, shown when the last
 * explicit update check flagged this skill. The flag lives in the skills
 * store so the toolbar's check, the list badge, and this banner agree.
 * Exported for parity in the mobile skill sheet's Overview tab.
 */
export function SkillUpdateBanner({ skill }: { skill: Skill }) {
  const t = useTranslations("skills.detail")
  const tToasts = useTranslations("skills.toasts")
  const updateAvailable = useSkillsStore((s) => Boolean(s.updateAvailable[skill.id]))
  const updates = useSkillUpdate()
  if (!updateAvailable) return null
  const handleUpdate = async () => {
    try {
      await updates.updateOne(skill)
      toast.success(tToasts("updated", { name: skill.name }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border border-dashed bg-muted/30 px-3 py-2"
      data-testid="skill-update-banner"
    >
      <span className="flex items-center gap-1.5 text-xs">
        <ArrowUpCircleIcon className="size-3.5 text-emerald-500" />
        {t("updateAvailable")}
      </span>
      <Button
        size="sm"
        className="min-h-11 md:min-h-8"
        onClick={() => void handleUpdate()}
        disabled={updates.updatingId === skill.id}
        data-testid="skill-update-button"
      >
        {updates.updatingId === skill.id ? (
          <Spinner className="mr-1.5 size-3" />
        ) : (
          <DownloadIcon className="mr-1.5 size-3.5" />
        )}
        {t("update")}
      </Button>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 border-b border-dashed py-1">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  )
}

function ContentSection({ skill }: { skill: Skill }) {
  // Reuse the chat MarkdownRenderer so the skill body gets Shiki syntax
  // highlighting, the same-line code toolbar (language + copy/download/wrap),
  // GFM tables, and math — instead of streamdown's plain fallback.
  return <MarkdownRenderer content={`## ${skill.name}\n\n${skill.content}`} />
}
