"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, DnaIcon } from "lucide-react"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { HarnessRunViewer } from "@/components/harness/harness-run-viewer"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useHarnessRun } from "@/hooks/harness/use-harness-data"
import { AGENTS_ROUTE, agentHref } from "@/lib/agents/routes"

export interface RouteBodyProps {
  runId: string
}

export default function RouteBody({ runId }: RouteBodyProps) {
  const t = useTranslations("harnessEvolution.page")
  const router = useRouter()
  const run = useHarnessRun(runId || undefined)
  const back = run ? agentHref(run.characterId, "evolve") : AGENTS_ROUTE
  return (
    <FeaturePageShell
      storageId="harness-run"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<DnaIcon />}
          breadcrumb={
            <Link
              href={back}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3.5" aria-hidden />
              {run ? t("backToAgent", { name: run.characterName }) : t("backToAgents")}
            </Link>
          }
          title={t("title")}
          testId="harness-run-page-header"
        />
      }
    >
      <div className="mx-auto w-full max-w-6xl px-6 py-6">
        {runId ? (
          <HarnessRunViewer runId={runId} onOpenExperience={() => router.push(back)} />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("noRunTitle")}</EmptyTitle>
              <EmptyDescription>{t("noRunBody")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </FeaturePageShell>
  )
}
