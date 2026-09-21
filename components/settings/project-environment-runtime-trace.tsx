"use client"

/**
 * "What the next run would do, and why" (ADR-0182).
 *
 * The preview is the real resolver's answer for the selection in the form,
 * so this card never reasons about precedence itself — it renders the
 * outcome, the notices and the resolver's own trace, step by step.
 *
 * It deliberately does NOT claim an isolation tier or a user as fact. Both
 * are requests here: the driver may attest a stronger tier, and a declared
 * user may be remapped onto the workspace owner. What a run actually got is
 * shown on the run itself (`SandboxPlacementBadge`), and the card says so.
 */

import { useTranslations } from "next-intl"
import { BanIcon, BoxIcon, CircleSlashIcon, TriangleAlertIcon } from "lucide-react"

import {
  FALLBACK_KEYS,
  NOTICE_KEYS,
  outcomeMessageValues,
  REFUSAL_KEYS,
} from "@/lib/sandbox/environment-outcome-message"
import type { SandboxPlacementOutcome } from "@/lib/sandbox/environment-placement"
import { cn } from "@/lib/utils"
import type { EnvironmentCatalogView } from "@/types/sandbox/environment-catalog"
import type { EnvironmentResolutionStep } from "@/types/sandbox/environment-spec"

/** Step codes this build has a sentence for; anything else prints its code. */
const STEP_CODES = new Set([
  "bundle_current",
  "bundle_pinned",
  "catalog_entry_selected",
  "declaration_approved",
  "deployment_default_selected",
  "egress_allowlist",
  "egress_off",
  "egress_open",
  "environment_approval_pending",
  "environment_declaration_invalid",
  "environment_declaration_restricted",
  "environment_declaration_unversioned",
  "isolation_floor",
  "isolation_project_minimum",
  "overridden_by_project_setting",
  "size_class_default",
  "size_class_selected",
  "user_declared",
  "user_from_image",
  "user_tier_default",
])

interface Props {
  preview: SandboxPlacementOutcome | undefined
  catalog: EnvironmentCatalogView | undefined
}

function Step({ step }: { step: EnvironmentResolutionStep }) {
  const t = useTranslations("projectEnvironment.runtime.trace.step")
  return (
    <li
      className={cn(
        "text-[10px]",
        step.outcome === "skipped" ? "text-muted-foreground line-through" : "text-foreground"
      )}
      data-outcome={step.outcome}
    >
      {STEP_CODES.has(step.code) ? t(step.code) : t("unknown", { code: step.code })}
    </li>
  )
}

export function ProjectEnvironmentRuntimeTrace({ preview, catalog }: Props) {
  const t = useTranslations("projectEnvironment.runtime")
  const tOutcome = useTranslations("projectEnvironment.outcome")

  if (!preview) return null

  const notices = preview.kind === "off" ? [] : preview.notices

  return (
    <div
      className="space-y-2 rounded-md border bg-background/40 p-3"
      data-testid="project-environment-runtime-trace"
      data-outcome={preview.kind}
    >
      <p className="text-xs font-medium">{t("preview.title")}</p>

      {preview.kind === "off" ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <CircleSlashIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {t("preview.off")}
        </p>
      ) : null}

      {preview.kind === "fallback" ? (
        <p
          role="status"
          className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-500"
        >
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {tOutcome(FALLBACK_KEYS[preview.code])}
        </p>
      ) : null}

      {preview.kind === "refused" ? (
        <p role="alert" className="flex items-start gap-1.5 text-[11px] text-destructive">
          <BanIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {tOutcome(REFUSAL_KEYS[preview.code], outcomeMessageValues(preview.detail))}
        </p>
      ) : null}

      {preview.kind === "placed" ? <PlacedSummary preview={preview} catalog={catalog} /> : null}

      {notices.length > 0 ? (
        <ul className="space-y-0.5" data-testid="runtime-trace-notices">
          {notices.map((notice) => (
            <li key={notice.code} className="text-[10px] text-amber-600 dark:text-amber-500">
              {tOutcome(NOTICE_KEYS[notice.code], outcomeMessageValues(notice.detail))}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function PlacedSummary({
  preview,
  catalog,
}: {
  preview: Extract<SandboxPlacementOutcome, { kind: "placed" }>
  catalog: EnvironmentCatalogView | undefined
}) {
  const t = useTranslations("projectEnvironment.runtime")
  const { spec } = preview.placement
  const image =
    spec.image.kind === "build"
      ? spec.image.imageId
      : `${spec.image.registry}/${spec.image.repository}@${spec.image.digest}`
  const size = catalog?.sizeClasses.find((entry) => entry.id === spec.sizeClassId)
  const declared = spec.user.declared
  // A user may be declared by name, by uid, or both; show whichever exists.
  const declaredName =
    declared?.name ?? (declared?.uid === undefined ? undefined : String(declared.uid))
  const steps = spec.explain?.steps ?? []

  return (
    <div className="space-y-1.5">
      <p className="flex items-start gap-1.5 text-[11px]">
        <BoxIcon className="mt-px size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
        <span className="min-w-0 break-all">{t("preview.placed", { image })}</span>
      </p>
      <p className="text-[10px] text-muted-foreground">
        {t("preview.requestedTier", { tier: t(`tier.${spec.isolation.minimum}`) })}
      </p>
      <p className="text-[10px] text-muted-foreground">
        {t("preview.size", { size: size?.label ?? spec.sizeClassId })}
      </p>
      <p className="text-[10px] text-muted-foreground">
        {declared && declaredName
          ? declared.from === "image"
            ? t("preview.imageUser", { user: declaredName })
            : t("preview.declaredUser", { user: declaredName })
          : t("preview.tierDefaultUser")}
      </p>
      <p className="text-[10px] text-muted-foreground">{t("preview.actualNote")}</p>
      {steps.length > 0 ? (
        <div>
          <p className="text-[10px] font-medium text-muted-foreground">{t("trace.title")}</p>
          <ol
            className="mt-0.5 list-inside list-decimal space-y-0.5"
            data-testid="runtime-trace-steps"
          >
            {steps.map((step, index) => (
              <Step key={`${step.layer}-${index}`} step={step} />
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  )
}
