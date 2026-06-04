"use client"

// Pinned / favorite workflows band, shown only at the library root. Reads the
// shared `pinnedWorkflowIds` settings field and renders the pinned workflows in
// the active view layout. A pinned workflow appears here regardless of which
// folder it actually lives in.

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { getDb } from "@/lib/db/schema"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import type { WorkflowRow as WorkflowRowType } from "@/types/workflow/visual"
import { WorkflowCard } from "./workflow-card"
import { WorkflowRow } from "./workflow-row"

// Stable fallback — returning a fresh `[]` from the selector would make
// `useSyncExternalStore` see a new snapshot every call and loop forever
// ("Maximum update depth exceeded" on the whole /workflows route).
const NO_PINNED: string[] = []

export function WorkflowPinnedSection() {
  const t = useTranslations("workflows.library.pinned")
  const pinnedIds = useSettingsStore((s) => s.settings?.pinnedWorkflowIds) ?? NO_PINNED
  const viewMode = useWorkflowLibraryStore((s) => s.viewMode)

  const rows = useLiveQuery(async () => {
    if (pinnedIds.length === 0) return []
    const got = await getDb().workflows.bulkGet(pinnedIds)
    return got.filter((w): w is WorkflowRowType => Boolean(w))
  }, [pinnedIds.join(",")])

  if (!rows || rows.length === 0) return null

  return (
    <section className="px-6 pt-4" data-testid="workflow-pinned-section">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("section")}
      </h2>
      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((w) => (
            <WorkflowCard key={w.id} workflow={w} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((w) => (
            <WorkflowRow key={w.id} workflow={w} />
          ))}
        </div>
      )}
    </section>
  )
}
