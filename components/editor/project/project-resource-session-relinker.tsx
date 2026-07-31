"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { LinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getDb } from "@/lib/db/schema"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

export function ProjectResourceSessionRelinker({
  resourceKey,
  projectId,
  rootId,
  relPath,
}: {
  resourceKey: string
  projectId: string
  rootId: string
  relPath: string
}) {
  const t = useTranslations("projectEditor.workbench")
  const setSessionOverride = useContextWorkbenchStore((state) => state.setSessionOverride)
  const candidates =
    useLiveQuery(async () => {
      const sessions = await getDb().sessions.toArray()
      return sessions.filter((session) => {
        const binding = session.surfaceBinding
        return (
          session.kind === "resource-workbench" &&
          binding?.kind === "project-file" &&
          binding.projectId === projectId &&
          binding.rootId === rootId &&
          binding.relPath !== relPath
        )
      })
    }, [projectId, relPath, rootId]) ?? []

  if (candidates.length === 0) return null
  return (
    <section className="border-t p-3">
      <h3 className="text-xs font-medium">{t("relinkTitle")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("relinkDescription")}</p>
      <div className="mt-2 space-y-1">
        {candidates.map((session) => {
          const binding = session.surfaceBinding
          if (binding?.kind !== "project-file") return null
          return (
            <Button
              key={session.id}
              type="button"
              size="sm"
              variant="outline"
              className="w-full justify-start"
              onClick={() => setSessionOverride(resourceKey, session.id)}
            >
              <LinkIcon className="size-3.5" />
              <span className="truncate">{binding.relPath}</span>
            </Button>
          )
        })}
      </div>
    </section>
  )
}
