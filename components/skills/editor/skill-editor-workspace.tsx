"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import {
  FilesIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  Settings2Icon,
  ShieldAlertIcon,
} from "lucide-react"
import { useSkillsStore } from "@/stores/skills"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { getSkill, updateSkill } from "@/lib/db/skills"
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import { SkillEditor } from "../skill-editor"
import { SkillFileTree } from "./skill-file-tree"
import { SkillTabStrip } from "./skill-tab-strip"
import { SkillMonacoEditor } from "./skill-monaco-editor"
import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { SkillValidationPanel } from "./skill-validation-panel"
import { useEditorWorkspace } from "./use-editor-workspace"
import { languageFromPath } from "./language-from-path"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { buildWorkbenchUri } from "@/lib/editor-workbench/monaco-workbench"
import {
  disposeWorkspace,
  ensureWorkspaceFiles,
  isLspWorkspaceManagerConfigured,
} from "@/lib/plugin/vscode-shim/lsp-workspace-manager"

/** localStorage key for the desktop three-pane split (percent layout, v4). */
const SKILL_EDITOR_LAYOUT_KEY = "cognia-skill-editor-layout"

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
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Desktop split persistence (react-resizable-panels v4 — PERCENT strings;
  // bare numbers are pixels). Seeded once at mount, written on change.
  const { defaultLayout, onLayoutChanged } = useResizableLayout(SKILL_EDITOR_LAYOUT_KEY)
  const [initialLayout] = useState<Record<string, number> | undefined>(() => defaultLayout)

  const skill = useLiveQuery(
    () => (ws.activeSkillId ? getSkill(ws.activeSkillId) : Promise.resolve(undefined)),
    [ws.activeSkillId]
  )
  const queriedResources = useLiveQuery(
    () => (ws.activeSkillId ? listResourcesForSkill(ws.activeSkillId) : Promise.resolve([])),
    [ws.activeSkillId]
  )
  const resources = useMemo(() => queriedResources ?? [], [queriedResources])

  useEffect(() => {
    if (!skill || !isLspWorkspaceManagerConfigured()) return
    const files = [
      {
        fileName: "SKILL.md",
        initialContent: skill.content,
        monacoUri: buildWorkbenchUri({
          surface: "skill",
          skillId: skill.id,
          documentId: "main",
          pathSegments: ["SKILL.md"],
          language: "markdown",
          initialContent: skill.content,
        }),
      },
      ...(skill.codexOpenAiYaml !== undefined
        ? [
            {
              fileName: "agents/openai.yaml",
              initialContent: skill.codexOpenAiYaml,
              monacoUri: buildWorkbenchUri({
                surface: "skill",
                skillId: skill.id,
                documentId: "codex",
                pathSegments: ["agents", "openai.yaml"],
                language: "yaml",
                initialContent: skill.codexOpenAiYaml,
              }),
            },
          ]
        : []),
      ...resources.map((resource) => ({
        fileName: resource.path,
        initialContent:
          resource.encoding === "base64"
            ? Uint8Array.from(atob(resource.content), (char) => char.charCodeAt(0))
            : resource.content,
        monacoUri: buildWorkbenchUri({
          surface: "skill",
          skillId: skill.id,
          documentId: resource.id,
          pathSegments: resource.path.split("/"),
          language: languageFromPath(resource.path),
          initialContent: resource.content,
        }),
      })),
    ]
    void ensureWorkspaceFiles({ surface: "skill", workspaceId: skill.id, files }).catch(() => {
      // LSP workspaces are desktop-only and best-effort; editing remains local.
    })
  }, [resources, skill])

  useEffect(() => {
    const skillId = skill?.id
    return () => {
      if (skillId && isLspWorkspaceManagerConfigured()) {
        void disposeWorkspace({ surface: "skill", documentId: skillId })
      }
    }
  }, [skill?.id])

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
  const activeSaveLabel = activeFile
    ? activeFile.saveState === "saving"
      ? t("saving")
      : activeFile.saveState === "conflict"
        ? t("saveConflict")
        : activeFile.saveState === "blocked"
          ? t("saveBlocked")
          : activeFile.saveState === "error"
            ? t("saveError")
            : activeFile.draftContent !== activeFile.savedContent
              ? t("unsaved")
              : t("saved")
    : ""
  const activeSaveDetail = activeFile
    ? activeFile.saveState === "conflict"
      ? t("saveConflictDetail")
      : activeFile.saveState === "blocked"
        ? t("saveBlockedDetail")
        : activeFile.saveState === "error"
          ? t("saveErrorDetail")
          : undefined
    : undefined

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
        } else if (sel.kind === "codex") {
          openFile({
            id: sel.id,
            kind: "codex",
            path: "agents/openai.yaml",
            language: "yaml",
            draftContent: sel.content,
            savedContent: sel.content,
          })
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

  // Sidebar header: the skill name plus the "Skill settings" entry that opens
  // the metadata editor (name / description / category / tags / tools / …).
  // The body + resources are edited as files; settings covers the frontmatter.
  const fileTreeHeader = (
    <div className="flex items-center justify-between gap-1 border-b bg-muted/30 px-2 py-1.5">
      <span className="truncate text-xs font-medium" title={skill.name}>
        {skill.name}
      </span>
      <Button
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label={t("openSettings")}
        onClick={() => setSettingsOpen(true)}
      >
        <Settings2Icon className="size-3.5" />
      </Button>
    </div>
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

  const tabStrip = (
    <SkillTabStrip
      files={ws.openFiles}
      activeFileId={ws.activeFileId}
      onSelect={setActiveFile}
      onClose={handleClose}
    />
  )

  const statusBar = (
    <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-3 py-1 font-mono text-[10px] text-muted-foreground">
      <span title={activeSaveDetail}>
        {activeFile?.language} • {activeSaveLabel}
      </span>
      {isMobile ? (
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          aria-label={t("openValidation")}
          onClick={() => setValidationSheetOpen(true)}
        >
          <ShieldAlertIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )

  const sharedOverlays = (
    <>
      {/* Skill settings (frontmatter metadata) — reuses the SkillEditor form in
          metadata-only mode. Saves only the metadata columns; the body stays
          owned by the Monaco tab so an in-flight draft is never clobbered. */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-lg">
          <SheetHeader className="border-b px-5 py-3">
            <SheetTitle>{t("settingsTitle")}</SheetTitle>
            <SheetDescription>{skill.name}</SheetDescription>
          </SheetHeader>
          <div className="px-5 py-4">
            <SkillEditor
              mode="edit"
              hideContent
              initial={skill}
              onCancel={() => setSettingsOpen(false)}
              onSave={async (draft) => {
                await updateSkill(skill.id, {
                  name: draft.name,
                  slug: draft.slug,
                  description: draft.description,
                  compatibility: draft.compatibility,
                  metadata: draft.metadata,
                  invocationPolicy: draft.invocationPolicy,
                  category: draft.category,
                  tags: draft.tags,
                  allowedTools: draft.allowedTools,
                  version: draft.version,
                  author: draft.author,
                  license: draft.license,
                  syncFingerprint: undefined,
                })
                toast.success(t("settingsSaved"))
                setSettingsOpen(false)
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

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
    </>
  )

  if (isMobile) {
    // Mobile: full-width editor; tree + validation live in Sheets. Monaco's
    // virtual-keyboard handling is unusable on touch — the CodeMirror light
    // editor provides highlighting/line numbers/find at a fraction of the
    // weight (and structurally no LSP wiring).
    return (
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col">
          <div className="flex items-center gap-1 border-b bg-muted/30 px-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label={t("openFileTree")}
              onClick={() => setFileTreeSheetOpen(true)}
            >
              <FilesIcon className="size-3.5" />
            </Button>
            <div className="min-w-0 flex-1">{tabStrip}</div>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label={t("openSettings")}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2Icon className="size-3.5" />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {activeFile ? (
              // key={} remount keeps undo stacks per file.
              <LightCodeEditor
                key={activeFile.id}
                value={activeFile.draftContent}
                language={activeFile.language}
                onChange={(v) => updateDraftContent(activeFile.id, v)}
                aria-label={activeFile.path}
              />
            ) : null}
            {statusBar}
          </div>
        </div>
        {sharedOverlays}
      </div>
    )
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={initialLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="skill-files"
          defaultSize="18%"
          minSize="10%"
          maxSize="35%"
          className="flex flex-col overflow-hidden border-r"
        >
          {fileTreeHeader}
          <div className="min-h-0 flex-1 overflow-y-auto">{fileTreeBody}</div>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label={t("resize.filesHandle")} />
        <ResizablePanel
          id="skill-editor"
          defaultSize={ws.rightPaneOpen ? "57%" : "82%"}
          minSize="30%"
          className="flex min-w-0 flex-col overflow-hidden"
        >
          {tabStrip}
          <div className="flex min-h-0 flex-1 flex-col">
            {activeFile ? (
              <SkillMonacoEditor
                key={activeFile.id}
                value={activeFile.draftContent}
                language={activeFile.language}
                onChange={(v) => updateDraftContent(activeFile.id, v)}
                skillId={ws.activeSkillId ?? undefined}
                documentId={activeFile.id}
                path={activeFile.path}
              />
            ) : null}
            {statusBar}
          </div>
        </ResizablePanel>
        {ws.rightPaneOpen ? (
          <>
            <ResizableHandle withHandle aria-label={t("resize.validationHandle")} />
            <ResizablePanel
              id="skill-validation"
              defaultSize="25%"
              minSize="15%"
              maxSize="40%"
              className="flex flex-col overflow-hidden border-l"
              data-testid="skill-validation-pane"
            >
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
              <div className="min-h-0 flex-1 overflow-y-auto">{validationBody}</div>
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
      {!ws.rightPaneOpen ? (
        <Button
          size="icon"
          variant="ghost"
          className="m-1 self-start"
          onClick={toggleRightPane}
          aria-label={t("panelValidation")}
        >
          <PanelRightOpenIcon className="size-3.5" />
        </Button>
      ) : null}
      {sharedOverlays}
    </div>
  )
}
