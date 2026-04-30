"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Streamdown } from "streamdown"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CopyIcon, DownloadIcon, PencilIcon, PowerIcon, Trash2Icon } from "lucide-react"
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
import { loggers } from "@/lib/logger"

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
  const resources = useLiveQuery(() => listResourcesForSkill(skill.id), [skill.id])

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
      <div className="flex shrink-0 items-start gap-3 border-b px-5 py-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${category.color}`}
        >
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{skill.name}</h2>
          {skill.description && (
            <p className="truncate text-xs text-muted-foreground">{skill.description}</p>
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
        <div className="flex shrink-0 flex-col gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openEdit(skill.id)}
            disabled={skill.isBuiltIn}
          >
            <PencilIcon className="mr-1.5 size-3.5" />
            {t("card.edit")}
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
        <TabsList className="mx-5 mt-2 self-start">
          <TabsTrigger value="overview">{tDetail("tabOverview")}</TabsTrigger>
          <TabsTrigger value="content">{tDetail("tabContent")}</TabsTrigger>
          <TabsTrigger value="resources">
            {tDetail("tabResources")}
            {resources && resources.length > 0 && (
              <span className="ml-1 text-[10px] opacity-60">{resources.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="security">{tDetail("tabSecurity")}</TabsTrigger>
        </TabsList>
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
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <Streamdown>{`## ${skill.name}\n\n${skill.content}`}</Streamdown>
    </div>
  )
}
