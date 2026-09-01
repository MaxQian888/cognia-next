"use client"

/**
 * Where a forked template came from, and what to do about it.
 *
 * A fork used to be a copy that forgot its origin, so a template based on a
 * built-in drifted away from it silently: no way to see a newer release had
 * landed, no common ancestor to merge against, no way to say "this is mine
 * now". The lineage this reads is LOCAL (`TemplateLocalRecord`), which is why
 * it is presented as a note about your own library rather than as provenance.
 * The trust badge elsewhere in the inspector still comes from
 * `provenance.trust` alone, because that is the only part a publisher signs.
 */

import { useTranslations } from "next-intl"
import { GitForkIcon, RefreshCwIcon, UnlinkIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import type { TemplateDerivation } from "@/lib/templates/repository"

export interface TemplateOriginCardProps {
  derivation: TemplateDerivation | undefined
  /** A newer upstream release, when one exists. Drives the update affordance. */
  upstream: TemplateDefinitionEnvelope | undefined
  onReviewUpdate: () => void
  onDetach: () => void
  busy?: boolean
  /** Authoring is desktop-only, so the phone shows the origin without actions. */
  readOnly?: boolean
}

export function TemplateOriginCard({
  derivation,
  upstream,
  onReviewUpdate,
  onDetach,
  busy = false,
  readOnly = false,
}: TemplateOriginCardProps) {
  const t = useTranslations("templateStudio.origin")
  if (!derivation) return null

  return (
    <Surface
      layer="raised"
      radius="control"
      className="space-y-2 p-3"
      data-testid="template-origin"
    >
      <div className="flex items-center gap-2">
        <GitForkIcon className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("title")}
        </h3>
      </div>
      <p className="break-all font-mono text-xs" data-testid="template-origin-source">
        {derivation.definitionId}
        {derivation.version ? `@${derivation.version}` : ""}
      </p>
      <p className="text-xs text-muted-foreground">{t("localOnly")}</p>
      {upstream ? (
        <Badge variant="secondary" data-testid="template-origin-update">
          {t("updateAvailable", { version: upstream.version ?? "" })}
        </Badge>
      ) : (
        <Badge variant="outline" data-testid="template-origin-current">
          {t("upToDate")}
        </Badge>
      )}
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2 pt-1">
          {upstream ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onReviewUpdate}
              data-testid="template-origin-review"
            >
              <RefreshCwIcon className="size-4" />
              {t("review")}
            </Button>
          ) : null}
          {/* Detaching is how a fork says it has become its own thing. It only
              forgets the origin, so the draft itself is untouched. */}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onDetach}
            data-testid="template-origin-detach"
          >
            <UnlinkIcon className="size-4" />
            {t("detach")}
          </Button>
        </div>
      )}
    </Surface>
  )
}
