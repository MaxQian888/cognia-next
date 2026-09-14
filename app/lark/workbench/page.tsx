"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { WorkspacePickerList } from "@/components/workspace/workspace-picker-list"
import { WorkspaceMembers } from "@/components/workspace/workspace-members"
import { WorkspaceActivity } from "@/components/workspace/workspace-activity"
import { refreshCollabPlane } from "@/lib/collab/refresh"
import { useProjectStore } from "@/stores/project/project-store"
import {
  checkLarkPersonalHost,
  loadLarkTeamWorkspaces,
  resolveLarkWorkbench,
  type LarkWorkbenchContext,
  type LarkWorkbenchOutcome,
} from "@/lib/connectors/lark-web/intent-client"

// This route is an entry gate. Chat, settings, devices and workspace panels
// remain on their existing routes and use the existing authenticated shell.
export default function LarkWorkbenchPage() {
  const t = useTranslations("larkEntry.workbench")
  const router = useRouter()
  const [outcome, setOutcome] = useState<LarkWorkbenchOutcome | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<Array<{ id: string; name: string }> | null>(null)
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null)
  const pending = useRef<{ revision: number; promise: Promise<LarkWorkbenchOutcome> } | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    let cancelled = false
    if (pending.current?.revision !== revision) {
      pending.current = {
        revision,
        promise: resolveLarkWorkbench({
          search: window.location.search,
          returnTo: window.location.pathname + window.location.search,
        }).catch(() => ({ kind: "error", code: "workbench_unavailable" })),
      }
    }
    void pending.current.promise.then((next) => {
      if (cancelled) return
      setOutcome(next)
      if (next.kind === "login") window.location.assign(next.loginUrl)
    })
    return () => {
      cancelled = true
      generation.current += 1
    }
  }, [revision])

  const open = async (
    context: LarkWorkbenchContext,
    mode: "personal" | "team",
    workspaceId?: string,
    issues = false
  ) => {
    if (busy) return
    const attempt = ++generation.current
    setBusy(true)
    setError(null)
    setSelected(null)
    try {
      // Re-resolve entry policy and principal for every action, including a
      // workspace selected after membership or adapter settings changed.
      const fresh = await resolveLarkWorkbench({
        search: window.location.search,
        returnTo: window.location.pathname + window.location.search,
      })
      if (attempt !== generation.current) return
      if (fresh.kind !== "ready") {
        setOutcome(fresh)
        setItems(null)
        if (fresh.kind === "login") window.location.assign(fresh.loginUrl)
        return
      }
      if (fresh.context.userId !== context.userId) {
        setError("identity_mismatch")
        return
      }
      if (mode === "personal") {
        const refused = await checkLarkPersonalHost(fresh.context)
        if (attempt !== generation.current) return
        if (refused) setError(refused)
        else router.push("/")
      } else {
        if (workspaceId) {
          const refreshed = await refreshCollabPlane()
          if (attempt !== generation.current) return
          if (refreshed.status !== "refreshed" || refreshed.userId !== fresh.context.userId) {
            setError("team_unavailable")
            return
          }
        }
        const team = await loadLarkTeamWorkspaces(fresh.context)
        if (attempt !== generation.current) return
        if (team.kind === "error") {
          setError(team.code)
          setItems(null)
          return
        }
        setItems(team.items)
        if (workspaceId) {
          const workspace = team.items.find((item) => item.id === workspaceId)
          if (!workspace) {
            setError("forbidden")
            return
          }
          setSelected(workspace)
          if (issues) {
            useProjectStore.getState().setActiveProject(workspaceId)
            router.push("/issues")
          }
        }
      }
    } catch {
      if (attempt === generation.current) setError("workbench_unavailable")
    } finally {
      if (attempt === generation.current) setBusy(false)
    }
  }

  const visibleError = error ?? (outcome?.kind === "error" ? outcome.code : null)
  const errorKey =
    visibleError && t.has(`errors.${visibleError}`) ? visibleError : "workbench_unavailable"
  return (
    <main className="flex min-h-svh w-full items-center justify-center p-4">
      <Card className={selected ? "w-full max-w-4xl" : "w-full max-w-lg"}>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("description")}</p>
          {(!outcome || outcome.kind === "login" || busy) && (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Spinner className="size-4" />
              {t(outcome?.kind === "login" ? "login" : "loading")}
            </p>
          )}
          {outcome?.kind === "ready" && (
            <>
              <div className="flex flex-wrap gap-2">
                {outcome.context.mode !== "team" && (
                  <Button disabled={busy} onClick={() => void open(outcome.context, "personal")}>
                    {t("personal")}
                  </Button>
                )}
                {outcome.context.mode !== "personal" && (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => void open(outcome.context, "team")}
                  >
                    {t("team")}
                  </Button>
                )}
              </div>
              {items && (
                <fieldset disabled={busy}>
                  <WorkspacePickerList
                    selection={{
                      items,
                      activeId: null,
                      onSelect: (id) => void open(outcome.context, "team", id),
                    }}
                  />
                </fieldset>
              )}
              {selected && (
                <section aria-label={selected.name} className="space-y-4">
                  <h2 className="text-lg font-semibold">{selected.name}</h2>
                  <Button
                    disabled={busy}
                    onClick={() => void open(outcome.context, "team", selected.id, true)}
                  >
                    {t("issues")}
                  </Button>
                  <WorkspaceMembers workspaceId={selected.id} />
                  <WorkspaceActivity workspaceId={selected.id} />
                </section>
              )}
            </>
          )}
          {visibleError && (
            <p role="alert" className="text-sm text-destructive">
              {t(`errors.${errorKey}`)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setOutcome(null)
                setError(null)
                setItems(null)
                setSelected(null)
                setRevision((value) => value + 1)
              }}
            >
              {t("retry")}
            </Button>
            <Button asChild variant="ghost">
              <Link href="/devices">{t("devices")}</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/me/cloud-account">{t("account")}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
