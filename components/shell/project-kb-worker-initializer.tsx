"use client"

import { useEffect } from "react"
import { useProjectStore } from "@/stores/project/project-store"
import { createProjectKnowledgeIngestController } from "@/lib/project-knowledge/wire-ingest"

/**
 * ProjectKnowledgeWorkerInitializer — the single app-level mount point that
 * keeps the project-scoped RAG index (`projectChunks`) in sync with each
 * workspace's `knowledgeBase`. Placed in the root layout so knowledge files are
 * (re)ingested / removed whenever the app is open, without needing the workspace
 * manager to be visible.
 *
 * It subscribes to `useProjectStore` and, on any change to the projects array
 * (debounced), reconciles via `createProjectKnowledgeIngestController`. All work
 * is best-effort: with no vector backend configured, `tryBuildProjectKnowledgeDeps`
 * returns undefined and reconcile is a no-op. The content-hash skip means an
 * already-indexed file is never re-embedded.
 */
export function ProjectKnowledgeWorkerInitializer() {
  useEffect(() => {
    const controller = createProjectKnowledgeIngestController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void controller.reconcile(useProjectStore.getState().projects)
      }, 800)
    }

    // Reconcile whatever is already loaded, then on every projects change.
    schedule()
    const unsubscribe = useProjectStore.subscribe((state, prev) => {
      if (state.projects !== prev.projects) schedule()
    })

    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  return null
}
