"use client"

import { useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { SparklesIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { loggers } from "@/lib/logging"
import { createSkill, deleteSkill, getSkill, updateSkill } from "@/lib/db/skills"
import { useSkills, useSkillShortcuts } from "@/hooks/skills"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { useSkillsStore } from "@/stores/skills"
import { useChatStore } from "@/stores/chat"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { SkillPanelHeader } from "./skill-panel-header"
import { SkillPanelTabs } from "./skill-panel-tabs"
import { SkillListPane } from "./skill-list-pane"
import { SkillDetail } from "./skill-detail"
import { SkillCategorySheet } from "./skill-category-sheet"
import { SkillFilterSheet } from "./skill-filter-sheet"
import { SkillBatchActionsBar } from "./skill-batch-actions-bar"
import { SkillDetailPanel } from "./skill-detail-panel"
import { SkillImportDialog } from "./skill-import-dialog"
import { SkillDeleteDialog } from "./skill-delete-dialog"
import { SkillUrlInstallDialog } from "./skill-url-install-dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useLiveQuery } from "dexie-react-hooks"
import { SkillEditor } from "./skill-editor"
import { SkillPanelProvider } from "./skill-panel-context"
import { SkillMarketplace } from "./skill-marketplace"
import { SkillAnalytics } from "./skill-analytics"
import { SkillEditorWorkspace } from "./editor/skill-editor-workspace"
import { useSkillAi } from "@/hooks/skills"
import { isTauri } from "@/lib/tauri"

interface Props {
  className?: string
}

export function SkillPanel({ className }: Props) {
  const view = useSkills()
  const activeTab = useSkillsStore((s) => s.activeTab)
  const detailSkillId = useSkillsStore((s) => s.detailSkillId)
  const openDetail = useSkillsStore((s) => s.openDetail)
  const closeDetail = useSkillsStore((s) => s.closeDetail)
  const openCreate = useSkillsStore((s) => s.openCreate)
  const isMobile = useIsMobile()
  const reduce = useReducedMotion()
  useSkillShortcuts(view.filtered)
  const fadeTransition = reduce
    ? { duration: 0 }
    : { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE }

  const enabledCount = useMemo(
    () => view.all.filter((s) => (s.status ?? "enabled") === "enabled").length,
    [view.all]
  )

  // Desktop master-detail: keep the detail pane pointed at a row that is
  // actually visible. A still-filtered selection is left alone; otherwise the
  // first filtered skill is selected (or the selection cleared when the list
  // is empty). Skipped on mobile so the detail Sheet never opens unprompted.
  useEffect(() => {
    if (isMobile || activeTab !== "my-skills") return
    const ids = view.filtered.map((s) => s.id)
    if (detailSkillId && ids.includes(detailSkillId)) return
    if (ids.length > 0) openDetail(ids[0])
    else closeDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `detailSkillId` is read but deliberately not a dep: re-running on selection writes would fight user clicks (mirrors provider-settings).
  }, [view.filtered, isMobile, activeTab])

  return (
    <SkillPanelProvider className={className}>
      <div className={cn("relative flex h-full min-h-0 flex-col overflow-hidden", className)}>
        <SkillPanelHeader
          totalCount={view.all.length}
          filteredCount={view.filtered.length}
          tabsSlot={<SkillPanelTabs className="border-0" />}
        />
        <div className="lg:hidden">
          <SkillPanelTabs />
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduce ? undefined : { opacity: 0 }}
              transition={fadeTransition}
              className="flex flex-1 min-h-0 overflow-hidden"
            >
              {activeTab === "my-skills" && (
                <div className="grid min-h-0 w-full flex-1 grid-cols-1 gap-3 p-3 sm:gap-4 sm:p-4 md:grid-cols-[320px_1fr]">
                  <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
                    <SkillListPane
                      skills={view.filtered}
                      total={view.all.length}
                      enabledCount={enabledCount}
                      countsBySource={view.countsBySource}
                      countsByCategory={view.countsByCategory}
                      onCreate={() => openCreate()}
                    />
                  </div>
                  {!isMobile && (
                    <div className="hidden min-h-0 flex-col overflow-hidden rounded-lg border md:flex">
                      <MySkillsDetailPane />
                    </div>
                  )}
                </div>
              )}
              {activeTab === "browse" && <SkillMarketplace />}
              {activeTab === "editor" && <SkillEditorWorkspace />}
              {activeTab === "analytics" && <SkillAnalytics />}
            </motion.div>
          </AnimatePresence>
        </div>

        <SkillCategorySheet
          total={view.all.length}
          countsByCategory={view.countsByCategory}
          countsBySource={view.countsBySource}
        />
        <SkillFilterSheet allTags={view.allTags} />
        <SkillBatchActionsBar />
        <SkillDetailPanel />
        <SkillEditorHost />
        <SkillImportHost />
        <SkillDeleteHost />
        <SkillUrlInstallDialog />
      </div>
    </SkillPanelProvider>
  )
}

/**
 * Right pane of the desktop master-detail layout: loads the selected skill
 * via live query and renders the (Sheet-agnostic) `SkillDetail` inline.
 */
function MySkillsDetailPane() {
  const t = useTranslations("skills")
  const detailSkillId = useSkillsStore((s) => s.detailSkillId)
  const skill = useLiveQuery(
    () => (detailSkillId ? getSkill(detailSkillId) : Promise.resolve(undefined)),
    [detailSkillId]
  )

  if (!detailSkillId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center">
        <SparklesIcon className="size-8 text-muted-foreground/40" />
        <p className="text-sm font-medium">{t("panel.selectSkillTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("panel.selectSkillHint")}</p>
      </div>
    )
  }
  if (!skill) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("loading")}
      </div>
    )
  }
  return <SkillDetail skill={skill} />
}

/**
 * Hosts the editor sheet. Reads `editorTarget` from the store so it can act
 * as both a "create" and "edit" surface.
 */
function SkillEditorHost() {
  const t = useTranslations("skills")
  const tToasts = useTranslations("skills.toasts")
  const editorTarget = useSkillsStore((s) => s.editorTarget)
  const createSeed = useSkillsStore((s) => s.createSeed)
  const closeEditor = useSkillsStore((s) => s.closeEditor)
  const open = editorTarget !== null
  const skill = useLiveQuery(
    () =>
      editorTarget?.mode === "edit" ? getSkill(editorTarget.skillId) : Promise.resolve(undefined),
    [editorTarget]
  )
  const ai = useSkillAi()

  const onSave = async (draft: Parameters<typeof createSkill>[0]) => {
    const mode = editorTarget?.mode
    try {
      if (mode === "create") {
        const created = await createSkill(draft)
        toast.success(tToasts("createdName", { name: draft.name }))
        loggers.skills.info("create ok", { skillId: created.id, name: draft.name })
      } else if (mode === "edit" && skill) {
        await updateSkill(skill.id, {
          name: draft.name,
          description: draft.description,
          content: draft.content,
          allowedTools: draft.allowedTools,
          tags: draft.tags,
          category: draft.category,
          version: draft.version,
          author: draft.author,
          license: draft.license,
        })
        toast.success(tToasts("updatedName", { name: draft.name }))
        loggers.skills.info("update ok", { skillId: skill.id, name: draft.name })
      }
      closeEditor()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("editor save failed", err, {
        mode,
        skillId: skill?.id,
        name: draft.name,
      })
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeEditor()}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-5 py-3">
          <SheetTitle>
            {editorTarget?.mode === "create" ? t("editor.create") : t("editor.save")}
          </SheetTitle>
          <SheetDescription>
            {editorTarget?.mode === "create" ? t("description") : (skill?.description ?? "")}
          </SheetDescription>
        </SheetHeader>
        <div className="px-5 py-4">
          <SkillEditor
            mode={editorTarget?.mode === "create" ? "create" : "edit"}
            initial={editorTarget?.mode === "create" ? createSeed : (skill ?? null)}
            onCancel={closeEditor}
            onSave={onSave}
            onAiAssist={
              isTauri()
                ? async (intent, current) => {
                    try {
                      return await ai.run(intent, current)
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : String(err))
                      loggers.skills.error("ai assist failed", err, { intent })
                      return null
                    }
                  }
                : undefined
            }
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SkillImportHost() {
  const tToasts = useTranslations("skills.toasts")
  const staging = useSkillsStore((s) => s.importStaging)
  const setImportStaging = useSkillsStore((s) => s.setImportStaging)
  if (!staging) return null
  return (
    <SkillImportDialog
      staging={staging}
      onCancel={() => setImportStaging(null)}
      onComplete={(report) => {
        const parts: string[] = []
        if (report.created > 0) parts.push(tToasts("importPartCreated", { count: report.created }))
        if (report.updated > 0) parts.push(tToasts("importPartUpdated", { count: report.updated }))
        if (report.skipped > 0) parts.push(tToasts("importPartSkipped", { count: report.skipped }))
        if (report.errored.length > 0)
          parts.push(tToasts("importPartErrored", { count: report.errored.length }))
        if (parts.length === 0) {
          toast.success(tToasts("importSummaryNoChanges"))
        } else {
          toast.success(tToasts("importSummary", { parts: parts.join(", ") }))
        }
        setImportStaging(null)
      }}
    />
  )
}

function SkillDeleteHost() {
  const tToasts = useTranslations("skills.toasts")
  const target = useSkillsStore((s) => s.deleteTarget)
  const setTarget = useSkillsStore((s) => s.setDeleteTarget)
  return (
    <SkillDeleteDialog
      open={target !== null}
      skillName={target?.name ?? ""}
      onCancel={() => setTarget(null)}
      onConfirm={async () => {
        if (!target) return
        try {
          await deleteSkill(target.skillId)
          // Drop any stale ad-hoc attachment so a deleted skill can't linger
          // as a dead id in the composer's ephemeral list.
          useChatStore.getState().removeEphemeralSkillIds([target.skillId])
          toast.success(tToasts("removedName", { name: target.name }))
          loggers.skills.info("remove ok", { skillId: target.skillId, name: target.name })
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err))
          loggers.skills.error("remove failed", err, {
            skillId: target.skillId,
            name: target.name,
          })
        } finally {
          setTarget(null)
        }
      }}
    />
  )
}
