"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useSkillsStore, type EditorFile } from "@/stores/skills"
import {
  saveSkillWorkspace,
  type SkillWorkspaceSaveFile,
  type SkillWorkspaceSaveResult,
} from "@/lib/db/skill-workspace"

const AUTOSAVE_MS = 2000

function toSaveFile(file: EditorFile): SkillWorkspaceSaveFile | null {
  if (file.kind === "main") {
    return {
      id: file.id,
      kind: "main",
      baseline: file.savedContent,
      content: file.draftContent,
    }
  }
  if (file.kind === "codex") {
    return {
      id: file.id,
      kind: "codex",
      baseline: file.savedContent,
      content: file.draftContent,
    }
  }
  if (!file.resourceId) return null
  return {
    id: file.id,
    kind: "resource",
    resourceId: file.resourceId,
    baseline: file.savedContent,
    content: file.draftContent,
  }
}

/** Per-file autosave and atomic Save All semantics for the Skill workspace. */
export function useEditorWorkspace() {
  const ws = useSkillsStore((s) => s.editorWorkspace)
  const markSaved = useSkillsStore((s) => s.markSaved)
  const markFileSaveState = useSkillsStore((s) => s.markFileSaveState)
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const [savedAllSignal, setSavedAllSignal] = useState(0)

  const persist = useCallback(
    async (files: EditorFile[]): Promise<SkillWorkspaceSaveResult> => {
      const skillId = useSkillsStore.getState().editorWorkspace.activeSkillId
      const saveFiles = files
        .map(toSaveFile)
        .filter((file): file is SkillWorkspaceSaveFile => !!file)
      const dirtyIds = saveFiles
        .filter((file) => file.content !== file.baseline)
        .map((file) => file.id)
      if (!skillId || dirtyIds.length === 0) return { status: "clean", savedFileIds: [] }

      markFileSaveState(dirtyIds, "saving")
      const result = await saveSkillWorkspace({ skillId, files: saveFiles })
      if (result.status === "saved") {
        for (const id of result.savedFileIds) {
          const file = files.find((candidate) => candidate.id === id)
          if (file) markSaved(id, file.draftContent)
        }
      } else if (result.status !== "clean") {
        // Save All is atomic: even when only one baseline caused the refusal,
        // every submitted file remains dirty and exits the transient saving state.
        markFileSaveState(dirtyIds, result.status, result.message)
      }
      return result
    },
    [markFileSaveState, markSaved]
  )

  const saveFile = useCallback(
    async (fileId: string): Promise<SkillWorkspaceSaveResult> => {
      const file = useSkillsStore
        .getState()
        .editorWorkspace.openFiles.find((candidate) => candidate.id === fileId)
      return file ? persist([file]) : { status: "clean", savedFileIds: [] }
    },
    [persist]
  )

  const saveActive = useCallback(async (): Promise<SkillWorkspaceSaveResult> => {
    const id = useSkillsStore.getState().editorWorkspace.activeFileId
    return id ? saveFile(id) : { status: "clean", savedFileIds: [] }
  }, [saveFile])

  const saveAll = useCallback(async (): Promise<SkillWorkspaceSaveResult> => {
    const files = useSkillsStore.getState().editorWorkspace.openFiles
    const result = await persist(files)
    if (result.status === "saved") setSavedAllSignal((value) => value + 1)
    return result
  }, [persist])

  useEffect(() => {
    for (const file of ws.openFiles) {
      if (file.draftContent === file.savedContent) continue
      clearTimeout(timersRef.current[file.id])
      timersRef.current[file.id] = setTimeout(() => {
        void saveFile(file.id)
      }, AUTOSAVE_MS)
    }
    const timers = timersRef.current
    return () => {
      for (const id in timers) clearTimeout(timers[id])
    }
  }, [ws.openFiles, saveFile])

  return { saveActive, saveAll, saveFile, savedAllSignal }
}
