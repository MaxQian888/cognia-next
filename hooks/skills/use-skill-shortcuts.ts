"use client"

/**
 * Keyboard shortcuts for the Skills panel, active while the panel is mounted.
 *
 *  - `/`            → focus the search box
 *  - Cmd/Ctrl + A   → select every skill in the current filtered view
 *  - Esc            → clear the selection, else close the open detail panel
 *  - N              → open the "create skill" editor
 *  - Delete         → open the delete confirm when exactly one skill is selected
 *
 * Bails whenever focus is inside an input / textarea / contenteditable (so the
 * keys type normally), except Escape which is always honored.
 */

import { useEffect } from "react"
import { useSkillsStore } from "@/stores/skills"
import type { Skill } from "@cognia/agent-config-types"

/** True when focus sits in an editable surface where the keys should type. */
function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as (HTMLElement & { isContentEditable?: boolean }) | null
  if (!node || typeof node.tagName !== "string") return false
  const tag = node.tagName.toLowerCase()
  return (
    tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable === true
  )
}

export function useSkillShortcuts(skills: Skill[]): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const store = useSkillsStore.getState()
      const editable = isEditableTarget(e.target)

      // Escape works everywhere: drop the selection, else close the detail.
      if (e.key === "Escape") {
        if (store.selection.size > 0) {
          e.preventDefault()
          store.clearSelection()
        } else if (store.detailSkillId) {
          e.preventDefault()
          store.closeDetail()
        }
        return
      }

      if (editable) return

      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault()
        store.selectAll(skills.map((s) => s.id))
        return
      }

      if (mod || e.altKey) return

      if (e.key === "/") {
        const input = document.querySelector<HTMLInputElement>("[data-skill-search]")
        if (input) {
          e.preventDefault()
          input.focus()
          input.select()
        }
        return
      }

      if (e.key.toLowerCase() === "n") {
        e.preventDefault()
        store.openCreate()
        return
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (store.selection.size === 1) {
          const id = Array.from(store.selection)[0]
          const skill = skills.find((s) => s.id === id)
          if (skill) {
            e.preventDefault()
            store.setDeleteTarget({ skillId: skill.id, name: skill.name })
          }
        }
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [skills])
}

export default useSkillShortcuts
