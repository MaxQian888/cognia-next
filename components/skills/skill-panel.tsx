"use client"

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { createSkill, deleteSkill, getSkill, updateSkill } from "@/lib/db/skills"
import { useSkills } from "@/hooks/use-skills"
import { useSkillsStore } from "@/stores/skills-store"
import { SkillPanelHeader } from "./skill-panel-header"
import { SkillPanelTabs } from "./skill-panel-tabs"
import { SkillPanelGrid } from "./skill-panel-grid"
import { SkillCategorySidebar } from "./skill-category-sidebar"
import { SkillFilterSheet } from "./skill-filter-sheet"
import { SkillBatchActionsBar } from "./skill-batch-actions-bar"
import { SkillDetailPanel } from "./skill-detail-panel"
import { SkillImportDialog } from "./skill-import-dialog"
import { SkillDeleteDialog } from "./skill-delete-dialog"
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
import { useSkillAi } from "@/hooks/use-skill-ai"
import { isTauri } from "@/lib/tauri"

interface Props {
  className?: string
}

export function SkillPanel({ className }: Props) {
  const t = useTranslations("skills")
  const view = useSkills()
  const activeTab = useSkillsStore((s) => s.activeTab)

  return (
    <SkillPanelProvider className={className}>
      <div className={cn("relative flex h-full min-h-0 flex-col overflow-hidden", className)}>
        <SkillPanelHeader totalCount={view.all.length} filteredCount={view.filtered.length} />
        <SkillPanelTabs />

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {activeTab === "my-skills" && (
            <>
              <SkillCategorySidebar
                total={view.all.length}
                countsByCategory={view.countsByCategory}
                countsBySource={view.countsBySource}
              />
              <ScrollArea className="flex-1">
                <SkillPanelGrid skills={view.filtered} />
              </ScrollArea>
            </>
          )}
          {activeTab === "browse" && <SkillMarketplace />}
          {activeTab === "editor" && <EditorTabPlaceholder />}
          {activeTab === "analytics" && <SkillAnalytics />}
        </div>

        <SkillFilterSheet allTags={view.allTags} />
        <SkillBatchActionsBar />
        <SkillDetailPanel />
        <SkillEditorHost />
        <SkillImportHost />
        <SkillDeleteHost />
      </div>
    </SkillPanelProvider>
  )

  function EditorTabPlaceholder() {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <div>
          <p className="font-medium">{t("tabs.editor")}</p>
          <p className="mt-1 text-xs">Open a skill from the My Skills grid to edit it inline.</p>
        </div>
      </div>
    )
  }
}

/**
 * Hosts the editor sheet. Reads `editorTarget` from the store so it can act
 * as both a "create" and "edit" surface.
 */
function SkillEditorHost() {
  const t = useTranslations("skills")
  const editorTarget = useSkillsStore((s) => s.editorTarget)
  const closeEditor = useSkillsStore((s) => s.closeEditor)
  const open = editorTarget !== null
  const skill = useLiveQuery(
    () =>
      editorTarget?.mode === "edit" ? getSkill(editorTarget.skillId) : Promise.resolve(undefined),
    [editorTarget]
  )
  const ai = useSkillAi()

  const onSave = async (draft: Parameters<typeof createSkill>[0]) => {
    try {
      if (editorTarget?.mode === "create") {
        await createSkill(draft)
        toast.success(`Created "${draft.name}".`)
      } else if (editorTarget?.mode === "edit" && skill) {
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
        toast.success(`Updated "${draft.name}".`)
      }
      closeEditor()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
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
            initial={skill ?? null}
            onCancel={closeEditor}
            onSave={onSave}
            onAiAssist={
              isTauri()
                ? async (intent, current) => {
                    try {
                      return await ai.run(intent, current)
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : String(err))
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
  const staging = useSkillsStore((s) => s.importStaging)
  const setImportStaging = useSkillsStore((s) => s.setImportStaging)
  if (!staging) return null
  return (
    <SkillImportDialog
      staging={staging}
      onCancel={() => setImportStaging(null)}
      onComplete={(report) => {
        const parts: string[] = []
        if (report.created > 0) parts.push(`${report.created} created`)
        if (report.updated > 0) parts.push(`${report.updated} updated`)
        if (report.skipped > 0) parts.push(`${report.skipped} skipped`)
        if (report.errored.length > 0) parts.push(`${report.errored.length} errored`)
        toast.success(`Imported — ${parts.join(", ") || "no changes"}.`)
        setImportStaging(null)
      }}
    />
  )
}

function SkillDeleteHost() {
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
          toast.success(`Removed "${target.name}".`)
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err))
        } finally {
          setTarget(null)
        }
      }}
    />
  )
}
