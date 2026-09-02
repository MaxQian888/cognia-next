"use client"

/**
 * What this Squad was made from, and what can still be done about it.
 *
 * A Squad instantiated through the template platform has a
 * `TemplateInstanceRecord`, which is the only place the link is kept: the
 * definition stays portable and the instance is the local record of "a template
 * was used here" (ADR-0100). Until the settings gallery started routing Use
 * through `service.instantiate`, no Squad had one, so the whole lifecycle the
 * ADR advertises was unreachable from the Squad side.
 *
 * `TemplateInstanceCard` is mounted rather than reimplemented. It already owns
 * the version picker, Detach, and the rebind path, and a second copy would be
 * two places to keep in step with `planUpdate`'s refusals. It takes a `title`
 * and a `summary` so this host can say "Created from Parallel review v1.2.0"
 * where the Studio says the raw definition id.
 *
 * A Squad with no record gets one sentence, not an empty card. "No lineage" and
 * "lineage that failed to load" look identical once the card is blank, and the
 * first is the common case: every Squad made before this existed, every one
 * made with New Squad, and every duplicate.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { toast } from "@/components/ui/sonner"
import { TemplateInstanceCard } from "@/components/templates/template-instance-card"
import { TemplateUpdateDialog } from "@/components/templates/template-update-dialog"
import { useSquadTemplateInstance } from "@/hooks/squads/use-squad-template-instance"
import type { TemplateCatalog } from "@/lib/templates/catalog"
import { getTemplateRuntime, type TemplateRuntime } from "@/lib/templates/runtime"
import type { TemplateConflictResolution, TemplateUpdatePlan } from "@/lib/templates/service"

export interface SquadTemplateProvenanceProps {
  squadId: string
  className?: string
  /** Injected in tests. Production resolves the singleton runtime. */
  runtime?: TemplateRuntime
  catalog?: TemplateCatalog
}

export function SquadTemplateProvenance({
  squadId,
  className,
  runtime,
  catalog,
}: SquadTemplateProvenanceProps) {
  const t = useTranslations("settings.squads.provenance")
  const resolved = runtime ?? getTemplateRuntime()
  const { instance, availableVersions, templateName, loading, refresh } = useSquadTemplateInstance(
    squadId,
    resolved,
    catalog
  )
  const [plan, setPlan] = useState<TemplateUpdatePlan | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : String(error))

  const openUpdate = (instanceId: string, version: string) => {
    setBusy(true)
    void resolved.service
      .planUpdate(instanceId, version)
      .then(setPlan)
      .catch(fail)
      .finally(() => setBusy(false))
  }

  const applyUpdate = (
    target: TemplateUpdatePlan,
    resolutions: Record<string, TemplateConflictResolution>
  ) => {
    setBusy(true)
    // `applyUpdate` throws without `confirmed: true`, so the dialog IS the
    // confirmation rather than this caller asserting one on the user's behalf.
    void resolved.service
      .applyUpdate(target, { confirmed: true, resolutions })
      .then(() => {
        setPlan(undefined)
        toast.success(t("updated", { version: target.next.version ?? "" }))
        refresh()
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }

  const detach = (instanceId: string) => {
    setBusy(true)
    void resolved.service
      .detachInstance(instanceId)
      .then(() => {
        toast.success(t("detached"))
        refresh()
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      className={className}
      testid="squad-provenance"
      settingId="squad-provenance"
    >
      {loading ? (
        <p className="text-xs text-muted-foreground">{t("loading")}</p>
      ) : instance ? (
        <>
          <TemplateInstanceCard
            instance={instance}
            title={
              instance.source.version
                ? t("createdFrom", {
                    name: templateName ?? instance.source.definitionId,
                    version: instance.source.version,
                  })
                : t("createdFromDraft", {
                    name: templateName ?? instance.source.definitionId,
                  })
            }
            summary={<p className="text-xs">{t("summary")}</p>}
            availableVersions={availableVersions}
            onPlanUpdate={openUpdate}
            onDetach={detach}
            busy={busy}
          />
          <TemplateUpdateDialog
            plan={plan}
            onOpenChange={(open) => {
              if (!open) setPlan(undefined)
            }}
            onConfirm={applyUpdate}
            busy={busy}
          />
        </>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="squad-provenance-none">
          {t("none")}
        </p>
      )}
    </SettingsBlock>
  )
}

export default SquadTemplateProvenance
