"use client"

/**
 * The Experience Library: lessons past runs drew about which harness changes
 * help and when. Lessons are editor inputs, never applied by themselves, and
 * are kept apart from Memory. A person can switch a lesson off, retire it, or
 * delete it; retired and rejected lessons are never retrieved.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { useHarnessExperiences } from "@/hooks/harness/use-harness-data"
import { cn } from "@/lib/utils"
import {
  HARNESS_EXPERIENCE_STATUSES,
  type HarnessExperience,
  type HarnessExperienceStatus,
} from "@/types/harness/experience"

const STATUS_VARIANT: Record<
  HarnessExperienceStatus,
  "success" | "outline" | "destructive" | "secondary"
> = {
  verified: "success",
  proposed: "outline",
  rejected: "destructive",
  deprecated: "secondary",
}

export interface HarnessExperienceLibraryProps {
  /** One agent's lessons, or every lesson on this device. */
  characterId?: string
  /** Open this lesson (from a run's reflection). Key the component by it to re-focus. */
  focusId?: string
  onOpenRun?: (runId: string) => void
}

async function patchExperience(id: string, patch: (e: HarnessExperience) => HarnessExperience) {
  const { updateHarnessExperience } = await import("@/lib/db/harness-evolution")
  return updateHarnessExperience(id, patch)
}

export function HarnessExperienceLibrary({
  characterId,
  focusId,
  onOpenRun,
}: HarnessExperienceLibraryProps) {
  const t = useTranslations("harnessEvolution.library")
  const experiences = useHarnessExperiences({ ...(characterId ? { characterId } : {}) })
  const [status, setStatus] = useState<HarnessExperienceStatus | "all">("all")
  const [open, setOpen] = useState<string | undefined>(focusId)
  const shown = useMemo(
    () => experiences.filter((e) => status === "all" || e.validationStatus === status),
    [experiences, status]
  )

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work()
    } catch (error) {
      toast.error(t("updateFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="harness-experience-library">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("intro")}</p>
        <NativeSelect
          size="sm"
          value={status}
          onChange={(e) => setStatus(e.target.value as HarnessExperienceStatus | "all")}
          aria-label={t("filter")}
        >
          <NativeSelectOption value="all">{t("all")}</NativeSelectOption>
          {HARNESS_EXPERIENCE_STATUSES.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {t(`status.${s}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="harness-experience-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((e) => {
            const expanded = open === e.id
            return (
              <li
                key={e.id}
                className={cn("rounded-md border p-3", e.disabled && "opacity-60")}
                data-testid={`harness-experience-${e.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? undefined : e.id)}
                  >
                    <p className="text-sm font-medium">{e.lesson}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("when", { cue: e.problemPattern })}
                    </p>
                  </button>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Badge variant={STATUS_VARIANT[e.validationStatus]}>
                      {t(`status.${e.validationStatus}`)}
                    </Badge>
                    <Badge variant="outline">{t(`confidence.${e.confidence}`)}</Badge>
                    <Badge variant="outline">{e.domain}</Badge>
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("counts", {
                    retrieved: e.retrievedCount,
                    helped: e.helpedCount,
                    hurt: e.hurtCount,
                  })}
                  {e.supportRunIds.length
                    ? ` · ${t("support", { count: e.supportRunIds.length })}`
                    : ""}
                  {e.conflictsWith.length
                    ? ` · ${t("conflicts", { count: e.conflictsWith.length })}`
                    : ""}
                </p>
                {expanded ? (
                  <div className="mt-3 flex flex-col gap-2 text-sm">
                    <p>
                      <span className="text-muted-foreground">{t("evidence")}: </span>
                      {e.evidenceSummary}
                    </p>
                    {e.confidenceReason ? (
                      <p className="text-xs text-muted-foreground">{e.confidenceReason}</p>
                    ) : null}
                    {e.applicableConditions.length ? (
                      <p className="text-xs">
                        {t("applies", { list: e.applicableConditions.join("; ") })}
                      </p>
                    ) : null}
                    {e.excludedConditions.length ? (
                      <p className="text-xs">
                        {t("excludes", { list: e.excludedConditions.join("; ") })}
                      </p>
                    ) : null}
                    {e.knownLimitations.length ? (
                      <p className="text-xs text-muted-foreground">
                        {t("limitations", { list: e.knownLimitations.join("; ") })}
                      </p>
                    ) : null}
                    {e.components.length ? (
                      <div className="flex flex-wrap gap-1">
                        {e.components.map((c) => (
                          <code key={c} className="rounded bg-muted px-1 text-xs">
                            {c}
                          </code>
                        ))}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <label className="flex items-center gap-2 text-xs">
                        <Switch
                          checked={!e.disabled}
                          onCheckedChange={(on) =>
                            void act(() =>
                              patchExperience(e.id, (cur) => ({
                                ...cur,
                                disabled: !on,
                                updatedAt: Date.now(),
                              }))
                            )
                          }
                          aria-label={t("enabled")}
                        />
                        {t("enabled")}
                      </label>
                      {e.validationStatus === "deprecated" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void act(() =>
                              patchExperience(e.id, (cur) => ({
                                ...cur,
                                validationStatus: "proposed",
                                updatedAt: Date.now(),
                              }))
                            )
                          }
                        >
                          {t("reinstate")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void act(() =>
                              patchExperience(e.id, (cur) => ({
                                ...cur,
                                validationStatus: "deprecated",
                                updatedAt: Date.now(),
                              }))
                            )
                          }
                          data-testid="harness-experience-retire"
                        >
                          {t("retire")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() =>
                          void act(async () => {
                            const { deleteHarnessExperience } =
                              await import("@/lib/db/harness-evolution")
                            await deleteHarnessExperience(e.id)
                          })
                        }
                        data-testid="harness-experience-delete"
                      >
                        {t("delete")}
                      </Button>
                      {onOpenRun ? (
                        <Button size="sm" variant="link" onClick={() => onOpenRun(e.sourceRunId)}>
                          {t("openRun")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
