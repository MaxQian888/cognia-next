"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useBestOfNRun } from "@/hooks/best-of-n/use-best-of-n-run"
import { dockSessionScopeKey } from "@/lib/artifacts/dock-pages"
import { useDockTabsStore } from "@/stores/artifact/dock-tabs-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

export function BestOfNRunCard({ groupId, sessionId }: { groupId: string; sessionId: string }) {
  const t = useTranslations("best-of-n-ui")
  const { summary, failed } = useBestOfNRun(groupId)
  const group = summary?.group
  const complete =
    group?.candidates.filter((candidate) =>
      ["succeeded", "failed", "cancelled", "recoveryRequired"].includes(candidate.status)
    ).length ?? 0
  return (
    <section className="my-2 space-y-2 rounded-md border p-3" aria-label={t("title")}>
      <p className="text-sm font-medium">{t("title")}</p>
      <p role="status" className="text-xs">
        {group ? t(`phase.${group.phase}`) : t("loading")}
        {group ? t("progress", { complete, total: group.n }) : null}
      </p>
      {group && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {group.candidates.map((candidate) => (
            <li key={candidate.candidateId}>
              {t("candidate", { number: candidate.index + 1 })}: {t(`status.${candidate.status}`)}
            </li>
          ))}
        </ul>
      )}
      {failed && <p role="alert">{t("refreshFailed")}</p>}
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          useDockTabsStore.getState().setBestOfNGroup(sessionId, groupId)
          useArtifactStore.getState().setActiveArtifact(null, sessionId)
          useContextWorkbenchStore
            .getState()
            .navigatePanel(dockSessionScopeKey(sessionId), "best-of-n", "wide")
          useArtifactDockLayoutStore.getState().setDockCollapsed(false)
        }}
      >
        {t("compare")}
      </Button>
    </section>
  )
}
