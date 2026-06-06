"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { FilesIcon, PanelRightCloseIcon, PanelRightOpenIcon, ShieldAlertIcon } from "lucide-react"
import { useSkillsStore } from "@/stores/skills"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { getSkill } from "@/lib/db/skills"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SkillFileTree } from "./skill-file-tree"
import { SkillTabStrip } from "./skill-tab-strip"
import { SkillMonacoEditor } from "./skill-monaco-editor"
import { SkillPlainEditor } from "./skill-plain-editor"
import { SkillValidationPanel } from "./skill-validation-panel"
import { useEditorWorkspace } from "./use-editor-workspace"
import { languageFromPath } from "./language-from-path"
import { useIsMobile } from "@/hooks/ui/use-mobile"

export function SkillEditorWorkspace() {
  const t = useTranslations("skills.editor")
  const ws = useSkillsStore((s) => s.editorWorkspace)
  const openFile = useSkillsStore((s) => s.openFile)
  const setActiveFile = useSkillsStore((s) => s.setActiveFile)
  const closeFile = useSkillsStore((s) => s.closeFile)
  const updateDraftContent = useSkillsStore((s) => s.updateDraftContent)
  const toggleRightPane = useSkillsStore((s) => s.toggleRightPane)
  const { saveActive, saveAll, savedAllSignal } = useEditorWorkspace()
  const isMobile = useIsMobile()
  const [closeTarget, setCloseTarget] = useState<{ fileId: string; path: string } | null>(null)
  const [fileTreeSheetOpen, setFileTreeSheetOpen] = useState(false)
  const [validationSheetOpen, setValidationSheetOpen] = useState(false)

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

  // Fire the "all saved" toast on the component side so the i18n message
  // resolves through the active locale (the hook stays framework-free).
  useEffect(() => {
    if (savedAllSignal === 0) return
    toast.success(t("savedAll"))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally key off the signal only
  }, [savedAllSignal])

  if (!skill) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t("emptyPickSkill")}
      </div>
    )
  }

  const activeFile = ws.openFiles.find((f) => f.id === ws.activeFileId) ?? ws.openFiles[0]

  const handleClose = (id: string, dirty: boolean) => {
    if (dirty) {
      const f = ws.openFiles.find((x) => x.id === id)
      if (f) setCloseTarget({ fileId: f.id, path: f.path })
      return
    }
    closeFile(id, true)
  }

  const fileTreeBody = (
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
        setFileTreeSheetOpen(false)
      }}
    />
  )

  const validationBody = activeFile ? (
    <SkillValidationPanel
      draft={{
        name: skill.name,
        description: skill.description,
        content: activeFile.kind === "main" ? activeFile.draftContent : skill.content,
      }}
      resources={resources}
    />
  ) : null

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Desktop: inline file-tree aside */}
      <aside className="hidden w-60 shrink-0 overflow-y-auto border-r md:block">
        {fileTreeBody}
      </aside>
      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-1 border-b bg-muted/30 px-1 md:hidden">
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label={t("openFileTree")}
            onClick={() => setFileTreeSheetOpen(true)}
          >
            <FilesIcon className="size-3.5" />
          </Button>
          <div className="flex-1 min-w-0">
            <SkillTabStrip
              files={ws.openFiles}
              activeFileId={ws.activeFileId}
              onSelect={setActiveFile}
              onClose={handleClose}
            />
          </div>
        </div>
        <div className="hidden md:block">
          <SkillTabStrip
            files={ws.openFiles}
            activeFileId={ws.activeFileId}
            onSelect={setActiveFile}
            onClose={handleClose}
          />
        </div>
        <div className="flex flex-1 overflow-hidden">
          <div className="flex flex-1 flex-col">
            {activeFile &&
              // Monaco's virtual-keyboard handling is unusable on touch
              // devices — swap in the plain-textarea fallback there. The
              // key={} remount keeps undo stacks per file in both modes.
              (isMobile ? (
                <SkillPlainEditor
                  key={activeFile.id}
                  value={activeFile.draftContent}
                  language={activeFile.language}
                  onChange={(v) => updateDraftContent(activeFile.id, v)}
                />
              ) : (
                <SkillMonacoEditor
                  key={activeFile.id}
                  value={activeFile.draftContent}
                  language={activeFile.language}
                  onChange={(v) => updateDraftContent(activeFile.id, v)}
                  skillId={ws.activeSkillId ?? undefined}
                  documentId={activeFile.id}
                />
              ))}
            <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-3 py-1 font-mono text-[10px] text-muted-foreground">
              <span>
                {activeFile?.language} •{" "}
                {activeFile && activeFile.draftContent !== activeFile.savedContent
                  ? t("unsaved")
                  : t("saved")}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-6 md:hidden"
                aria-label={t("openValidation")}
                onClick={() => setValidationSheetOpen(true)}
              >
                <ShieldAlertIcon className="size-3.5" />
              </Button>
            </div>
          </div>
          {/* Desktop: inline validation aside (toggleable) */}
          <div className="hidden md:flex md:shrink-0">
            {ws.rightPaneOpen ? (
              <aside className="w-80 shrink-0 border-l">
                <div className="flex items-center justify-between border-b px-2 py-1">
                  <span className="text-xs font-medium">{t("panelValidation")}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    onClick={toggleRightPane}
                    aria-label={t("panelValidation")}
                  >
                    <PanelRightCloseIcon className="size-3.5" />
                  </Button>
                </div>
                {validationBody}
              </aside>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="m-1 self-start"
                onClick={toggleRightPane}
                aria-label={t("panelValidation")}
              >
                <PanelRightOpenIcon className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Mobile: file-tree as Sheet */}
      <Sheet open={fileTreeSheetOpen} onOpenChange={setFileTreeSheetOpen}>
        <SheetContent side="left" className="w-72 p-0 sm:w-80">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle>{t("fileTreeAria")}</SheetTitle>
            <SheetDescription>{skill.name}</SheetDescription>
          </SheetHeader>
          <div className="h-full overflow-y-auto">{fileTreeBody}</div>
        </SheetContent>
      </Sheet>

      {/* Mobile: validation panel as a thumb-reachable bottom drawer */}
      <Sheet open={validationSheetOpen} onOpenChange={setValidationSheetOpen}>
        <SheetContent side="bottom" className="h-[60vh] p-0 safe-area-pb">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle>{t("panelValidation")}</SheetTitle>
            <SheetDescription>{skill.name}</SheetDescription>
          </SheetHeader>
          <div className="h-full overflow-y-auto">{validationBody}</div>
        </SheetContent>
      </Sheet>

      {/* Close-dirty confirmation dialog */}
      <AlertDialog open={closeTarget !== null} onOpenChange={(o) => !o && setCloseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("closeDirtyTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {closeTarget ? t("closeDirtyBody", { path: closeTarget.path }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setCloseTarget(null)}>
              {t("closeDirtyKeep")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (closeTarget) closeFile(closeTarget.fileId, true)
                setCloseTarget(null)
              }}
            >
              {t("closeDirtyDiscard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
