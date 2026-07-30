"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { PlayIcon, SparklesIcon } from "lucide-react"
import { listTemplateWorkflows } from "@/lib/db/workflows"
import { WorkflowCard } from "@/components/workflow/library/workflow-card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { usePlatform } from "@/hooks/use-platform"
import { useTemplateCatalog } from "@/hooks/use-template-catalog"
import { getTemplateRuntime } from "@/lib/templates/runtime"

export function TemplatesTab() {
  const t = useTranslations("workflows.templateLibrary")
  const router = useRouter()
  const platform = usePlatform()
  const runtime = useMemo(() => getTemplateRuntime(), [])
  const legacyTemplates = useLiveQuery(() => listTemplateWorkflows(), [])
  const { definitions } = useTemplateCatalog({ domain: "workflow" })
  const [creating, setCreating] = useState<string>()

  const instantiate = async (definition: (typeof definitions)[number]) => {
    setCreating(definition.contentHash)
    try {
      const plan = await runtime.service.preflight({
        definitionId: definition.id,
        ...(definition.version ? { version: definition.version } : {}),
        platform: platform === "mobile" ? "mobile" : platform === "web" ? "web" : "desktop",
        bindings: {},
      })
      if (plan.status !== "ready") {
        router.push(`/templates?definition=${encodeURIComponent(definition.id)}`)
        return
      }
      const result = await runtime.service.instantiate({ plan, confirmed: false })
      const workflowId = result.resources.find((resource) => resource.domain === "workflow")?.id
      if (workflowId) router.push(`/workflows/editor?id=${encodeURIComponent(workflowId)}`)
    } finally {
      setCreating(undefined)
    }
  }

  if (legacyTemplates === undefined && definitions.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
    )
  }

  if (definitions.length === 0 && legacyTemplates?.length === 0) {
    return (
      <Empty className="mx-auto max-w-md py-12">
        <EmptyHeader>
          <EmptyMedia>
            <SparklesIcon className="size-8" aria-hidden="true" />
          </EmptyMedia>
        </EmptyHeader>
        <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
        <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
      </Empty>
    )
  }

  if (definitions.length > 0) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {definitions.map((definition) => (
          <Card key={`${definition.id}@${definition.version ?? definition.revision}`}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base">{definition.metadata.name}</CardTitle>
                <Badge variant="outline">
                  {t(`trust.${definition.provenance.trust ?? "unsigned"}`)}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="line-clamp-3 text-sm text-muted-foreground">
                {definition.metadata.description ?? t("noDescription")}
              </p>
              <Button
                size="sm"
                onClick={() => void instantiate(definition)}
                disabled={creating === definition.contentHash}
              >
                <PlayIcon className="size-4" />
                {creating === definition.contentHash ? t("creating") : t("create")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {legacyTemplates?.map((wf) => (
        <WorkflowCard key={wf.id} workflow={wf} />
      ))}
    </div>
  )
}
