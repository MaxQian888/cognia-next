"use client"

/**
 * The inspector's deliverables: what the issue's runs handed over
 * (`issue.link_artifact`), grouped into versions by `groupIssueDeliverables`.
 *
 * Each deliverable shows its newest version; older versions stay one click
 * away. A Cognia artifact previews inline through the artifact surface's own
 * `ArtifactPreview` (so every artifact type renders here exactly as it does
 * in its conversation); anything else is a link.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { ArtifactPreview } from "@/components/artifacts/artifact-preview"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { groupIssueDeliverables, type IssueDeliverable } from "@/lib/issues/deliverables"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { IssueRun } from "@/types/issues"
import { IssueRunArtifactLink } from "./issue-run-artifact-link"

export interface IssueDeliverablesSectionProps {
  runs: readonly IssueRun[]
}

function DeliverableRow({ deliverable }: { deliverable: IssueDeliverable }) {
  const t = useTranslations("issues")
  const [selected, setSelected] = useState(0)
  const version = deliverable.versions[Math.min(selected, deliverable.versions.length - 1)]!
  const artifactId = version.artifact.artifactId
  const artifact = useArtifactStore((state) =>
    artifactId ? state.artifacts[artifactId] : undefined
  )

  return (
    <li
      className="flex flex-col gap-1.5 rounded-md border px-2 py-1.5 text-xs"
      data-testid={`issue-deliverable-${deliverable.key}`}
    >
      <span className="flex items-center gap-2">
        <IssueRunArtifactLink artifact={version.artifact} testId="issue-deliverable-open" />
        <Badge variant="secondary" className="h-4 px-1 text-[10px]">
          {t("deliverables.version", { version: version.version })}
        </Badge>
        <span className="ml-auto text-muted-foreground">
          {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
            version.linkedAt
          )}
        </span>
      </span>
      {deliverable.versions.length > 1 ? (
        <span
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t("deliverables.versions")}
        >
          {deliverable.versions.map((candidate, index) => (
            <Button
              key={`${candidate.runId}:${candidate.artifact.href}`}
              size="sm"
              variant={index === selected ? "secondary" : "ghost"}
              className="h-5 px-1.5 text-[10px]"
              aria-pressed={index === selected}
              onClick={() => setSelected(index)}
              data-testid={`issue-deliverable-version-${candidate.version}`}
            >
              {t("deliverables.version", { version: candidate.version })}
            </Button>
          ))}
        </span>
      ) : null}
      {artifact ? (
        <div
          className="max-h-72 overflow-auto rounded border"
          data-testid="issue-deliverable-preview"
        >
          <ArtifactPreview artifact={artifact} className="min-h-[160px]" />
        </div>
      ) : artifactId ? (
        <p className="italic text-muted-foreground">{t("deliverables.previewUnavailable")}</p>
      ) : null}
    </li>
  )
}

export function IssueDeliverablesSection({ runs }: IssueDeliverablesSectionProps) {
  const t = useTranslations("issues")
  const deliverables = useMemo(() => groupIssueDeliverables(runs), [runs])
  if (deliverables.length === 0) return null
  return (
    <section className="flex flex-col gap-2" data-testid="issue-detail-deliverables">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("deliverables.section")}
      </h3>
      <ol className="flex flex-col gap-2">
        {deliverables.map((deliverable) => (
          <DeliverableRow key={deliverable.key} deliverable={deliverable} />
        ))}
      </ol>
    </section>
  )
}
