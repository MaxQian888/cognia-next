"use client"

import { useCallback, useEffect, useRef } from "react"
import { useSkillsStore } from "@/stores/skills"
import { getSkill, updateSkill } from "@/lib/db/skills"
import { updateResource } from "@/lib/db/skill-resources"
import { validateSkill } from "@/lib/skills/validate"
import { toast } from "sonner"

const AUTOSAVE_MS = 2000

/**
 * Per-file autosave + Cmd-S save semantics for the editor workspace.
 *
 * Save semantics:
 *   • Per-file save → updateSkill (main) or updateResource (resource).
 *   • Save all → main first, then every resource.
 *   • Autosave debounces 2s per file. The main file is held back from
 *     autosave when the current draft would fail validation; resources
 *     autosave unconditionally.
 */
export function useEditorWorkspace() {
  const ws = useSkillsStore((s) => s.editorWorkspace)
  const markSaved = useSkillsStore((s) => s.markSaved)
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const saveFile = useCallback(
    async (fileId: string) => {
      const state = useSkillsStore.getState().editorWorkspace
      const file = state.openFiles.find((f) => f.id === fileId)
      if (!file) return
      if (file.draftContent === file.savedContent) return
      if (file.kind === "main" && state.activeSkillId) {
        const skill = await getSkill(state.activeSkillId)
        if (!skill) return
        const errors = validateSkill({
          name: skill.name,
          description: skill.description,
          content: file.draftContent,
        })
        const blocking = errors.some(
          (e) => e.code === "missing-name" || e.code === "missing-content"
        )
        if (blocking) return
        await updateSkill(state.activeSkillId, {
          content: file.draftContent,
          validationErrors: errors,
        })
      } else if (file.kind === "resource" && file.resourceId) {
        await updateResource(file.resourceId, { content: file.draftContent })
      } else {
        return
      }
      markSaved(fileId, file.draftContent)
    },
    [markSaved]
  )

  const saveActive = useCallback(async () => {
    const id = useSkillsStore.getState().editorWorkspace.activeFileId
    if (!id) return
    await saveFile(id)
  }, [saveFile])

  const saveAll = useCallback(async () => {
    const state = useSkillsStore.getState().editorWorkspace
    const main = state.openFiles.find((f) => f.kind === "main")
    if (main) await saveFile(main.id)
    for (const f of state.openFiles.filter((x) => x.kind === "resource")) {
      await saveFile(f.id)
    }
    toast.success("All saved.")
  }, [saveFile])

  // Autosave per file (debounced).
  useEffect(() => {
    for (const f of ws.openFiles) {
      if (f.draftContent === f.savedContent) continue
      clearTimeout(timersRef.current[f.id])
      timersRef.current[f.id] = setTimeout(() => {
        void saveFile(f.id)
      }, AUTOSAVE_MS)
    }
    const timers = timersRef.current
    return () => {
      for (const id in timers) clearTimeout(timers[id])
    }
  }, [ws.openFiles, saveFile])

  return { saveActive, saveAll, saveFile }
}
