"use client"

import { useCallback, useEffect, useState } from "react"
import { FolderTreeIcon, RefreshCwIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Surface } from "@/components/surface/surface"
import { listWorkspaceRoots } from "@/lib/files/workspace-fs"
import type { WorkspaceRoot } from "@/lib/files/types"

/**
 * Read-only view of the folders the Host will browse.
 *
 * It is read-only on purpose. A headless Host takes its root from
 * `COGNIA_WORKSPACES_DIR` when the process starts, so letting a paired client
 * edit it here would mean a remote device could widen the Host's filesystem
 * reach. What the user actually needs from this screen is the fact that was
 * missing everywhere else: which folders are allowed, and where to go to change
 * them.
 */
export function WorkspaceRootsCard() {
  const t = useTranslations("mobile.companion.workspaceRoots")
  const [roots, setRoots] = useState<WorkspaceRoot[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      setRoots(await listWorkspaceRoots())
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async roots load
    void refresh()
  }, [refresh])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex items-center gap-2">
              <FolderTreeIcon className="size-4 shrink-0" />
              {t("title")}
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("refresh")}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {failed ? (
          <p className="text-sm text-destructive">{t("loadError")}</p>
        ) : roots === null ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : roots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-2" aria-label={t("title")}>
            {roots.map((root) => (
              <Surface asChild key={root.path} layer="raised">
                <li className="rounded-md border px-3 py-2">
                  <p className="font-mono text-xs break-all">{root.path}</p>
                  <p className="pt-1 text-xs text-muted-foreground">
                    {root.source === "headless-workspaces-dir"
                      ? t("sourceHeadless")
                      : t("sourceDesktop")}
                  </p>
                  <p className="pt-0.5 text-xs text-muted-foreground">
                    {root.source === "headless-workspaces-dir"
                      ? t("hintHeadless")
                      : t("hintDesktop")}
                  </p>
                </li>
              </Surface>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export default WorkspaceRootsCard
