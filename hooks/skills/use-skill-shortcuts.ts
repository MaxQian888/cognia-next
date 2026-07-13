"use client"

/**
 * Rebindable keyboard shortcuts for the Skills panel, registered while it is
 * mounted:
 *
 *  - `skills.search`         `/`             → focus the search box
 *  - `skills.selectAll`      Cmd/Ctrl + A    → select every skill in view
 *  - `skills.clearSelection` Esc             → clear selection, else close detail
 *  - `skills.create`         N               → open the "create skill" editor
 *  - `skills.delete`         Delete / Backspace → delete when exactly one selected
 *
 * The single dispatcher owns the listener + editable guard, so the keys type
 * normally inside a field — except Esc, which stays active everywhere
 * (`allowInEditable`). `preventDefault` is called by each handler exactly where
 * the pre-migration code did, so a no-op press still types through.
 */

import { useSkillsStore } from "@/stores/skills"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import type { Skill } from "@cognia/agent-config-types"

export function useSkillShortcuts(skills: Skill[]): void {
  // Escape works everywhere: drop the selection, else close the detail panel.
  useAppShortcut(
    "skills.clearSelection",
    (e) => {
      const store = useSkillsStore.getState()
      if (store.selection.size > 0) {
        e.preventDefault()
        store.clearSelection()
      } else if (store.detailSkillId) {
        e.preventDefault()
        store.closeDetail()
      }
    },
    { allowInEditable: true }
  )

  useAppShortcut("skills.selectAll", (e) => {
    e.preventDefault()
    useSkillsStore.getState().selectAll(skills.map((s) => s.id))
  })

  useAppShortcut("skills.search", (e) => {
    const input = document.querySelector<HTMLInputElement>("[data-skill-search]")
    if (input) {
      e.preventDefault()
      input.focus()
      input.select()
    }
  })

  useAppShortcut("skills.create", (e) => {
    e.preventDefault()
    useSkillsStore.getState().openCreate()
  })

  useAppShortcut("skills.delete", (e) => {
    const store = useSkillsStore.getState()
    if (store.selection.size !== 1) return
    const id = Array.from(store.selection)[0]
    const skill = skills.find((s) => s.id === id)
    if (skill) {
      e.preventDefault()
      store.setDeleteTarget({ skillId: skill.id, name: skill.name })
    }
  })
}

export default useSkillShortcuts
