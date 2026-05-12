"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react"
import { useSkillsStore } from "@/stores/skills"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { getSkill } from "@/lib/db/skills"
import { Button } from "@/components/ui/button"
import { SkillFileTree } from "./skill-file-tree"
import { SkillTabStrip } from "./skill-tab-strip"
import { SkillMonacoEditor } from "./skill-monaco-editor"
import { SkillValidationPanel } from "./skill-validation-panel"
import { useEditorWorkspace } from "./use-editor-workspace"
import { languageFromPath } from "./language-from-path"

export function SkillEditorWorkspace() {
  const t = useTranslations("skills.editor")
  const ws = useSkillsStore((s) => s.editorWorkspace)
  const openFile = useSkillsStore((s) => s.openFile)
  const setActiveFile = useSkillsStore((s) => s.setActiveFile)
  const closeFile = useSkillsStore((s) => s.closeFile)
  const updateDraftContent = useSkillsStore((s) => s.updateDraftContent)
  const toggleRightPane = useSkillsStore((s) => s.toggleRightPane)
  const { saveActive, saveAll } = useEditorWorkspace()

  const skill = useLiveQuery(
    () => (ws.activeSkillId ? getSkill(ws.activeSkillId) : Promise.resolve(undefined)),
    [ws.activeSkillId]
  )
  const resources =
    useLiveQuery(
      () => (ws.activeSkillId ? listResourcesForSkill(ws.activeSkillId) : Promise.resolve([])),
      [ws.activeSkillId]
    ) ?? []

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.ctrlKey || e.metaKey
      if (cmd && e.key === "s" && !e.shiftKey) {
        e.preventDefault()
        void saveActive()
      } else if (cmd && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault()
        void saveAll()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [saveActive, saveAll])

  if (!skill) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("emptyPickSkill")}
      </div>
    )
  }

  const activeFile = ws.openFiles.find((f) => f.id === ws.activeFileId) ?? ws.openFiles[0]

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="w-60 shrink-0 overflow-y-auto border-r">
        <SkillFileTree
          skill={skill}
          resources={resources}
          activeFileId={ws.activeFileId}
          onSelect={(sel) => {
            if (sel.kind === "main") {
              setActiveFile("main")
            } else {
              openFile({
                id: sel.resource.id,
                kind: "resource",
                resourceId: sel.resource.id,
                path: sel.resource.path,
                language: languageFromPath(sel.resource.path),
                draftContent: sel.resource.content,
                savedContent: sel.resource.content,
              })
            }
          }}
        />
      </aside>
      <div className="flex flex-1 flex-col">
        <SkillTabStrip
          files={ws.openFiles}
          activeFileId={ws.activeFileId}
          onSelect={setActiveFile}
          onClose={(id, dirty) => {
            if (dirty && !window.confirm(t("closeDirtyConfirm"))) return
            closeFile(id, true)
          }}
        />
        <div className="flex flex-1 overflow-hidden">
          <div className="flex flex-1 flex-col">
            {activeFile && (
              <SkillMonacoEditor
                value={activeFile.draftContent}
                language={activeFile.language}
                onChange={(v) => updateDraftContent(activeFile.id, v)}
              />
            )}
            <div className="border-t bg-muted/30 px-3 py-1 font-mono text-[10px] text-muted-foreground">
              {activeFile?.language} •{" "}
              {activeFile && activeFile.draftContent !== activeFile.savedContent
                ? t("unsaved")
                : t("saved")}
            </div>
          </div>
          {ws.rightPaneOpen ? (
            <aside className="w-80 shrink-0 border-l">
              <div className="flex items-center justify-between border-b px-2 py-1">
                <span className="text-xs font-medium">{t("panelValidation")}</span>
                <Button size="icon" variant="ghost" className="size-6" onClick={toggleRightPane}>
                  <PanelRightCloseIcon className="size-3.5" />
                </Button>
              </div>
              <SkillValidationPanel
                draft={{
                  name: skill.name,
                  description: skill.description,
                  content: activeFile?.kind === "main" ? activeFile.draftContent : skill.content,
                }}
                resources={resources}
              />
            </aside>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="m-1 self-start"
              onClick={toggleRightPane}
            >
              <PanelRightOpenIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
