"use client"

/**
 * The deterministic checks a task's rollouts must pass. Selection reads them
 * before any model judgement, so a task with good checks is decided on
 * evidence. Acceptance profiles are offered only on a git task in a
 * workspace, and only those the workspace approved.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type {
  HarnessIsolationKind,
  HarnessTaskCheck,
  HarnessTaskCheckKind,
} from "@/types/harness/evolution"

const KINDS: readonly HarnessTaskCheckKind[] = [
  "output-contains",
  "output-not-contains",
  "output-json",
  "max-tool-errors",
  "deliverable-file",
  "acceptance-profile",
]

function blank(kind: HarnessTaskCheckKind): HarnessTaskCheck {
  switch (kind) {
    case "deliverable-file":
      return { kind, path: "" }
    case "output-contains":
    case "output-not-contains":
      return { kind, value: "" }
    case "output-json":
      return { kind }
    case "max-tool-errors":
      return { kind, max: 0 }
    case "acceptance-profile":
      return { kind, profileId: "" }
  }
}

/** Kinds a task of this shape can check. */
export function availableCheckKinds(
  isolation: HarnessIsolationKind,
  projectId: string | undefined
): HarnessTaskCheckKind[] {
  return KINDS.filter((kind) => {
    if (kind === "deliverable-file") return isolation !== "none"
    if (kind === "acceptance-profile") return isolation === "git" && !!projectId
    return true
  })
}

function useApprovedProfiles(projectId: string | undefined, wanted: boolean): string[] {
  const [loaded, setLoaded] = useState<{ projectId: string; ids: string[] } | null>(null)
  useEffect(() => {
    if (!wanted || !projectId) return
    let cancelled = false
    void import("@/lib/router-fusion/verify/acceptance-profiles")
      .then((m) => m.listAcceptanceProfiles(projectId))
      .then((listing) => {
        if (cancelled) return
        const ids =
          listing.kind === "declared"
            ? listing.profiles.filter((p) => p.status === "approved").map((p) => p.id)
            : []
        setLoaded({ projectId, ids })
      })
      .catch(() => !cancelled && setLoaded({ projectId, ids: [] }))
    return () => {
      cancelled = true
    }
  }, [projectId, wanted])
  return loaded && loaded.projectId === projectId ? loaded.ids : []
}

export interface HarnessTaskChecksEditorProps {
  checks: HarnessTaskCheck[]
  onChange: (checks: HarnessTaskCheck[]) => void
  isolation: HarnessIsolationKind
  projectId?: string
}

export function HarnessTaskChecksEditor({
  checks,
  onChange,
  isolation,
  projectId,
}: HarnessTaskChecksEditorProps) {
  const t = useTranslations("harnessEvolution")
  const kinds = availableCheckKinds(isolation, projectId)
  const [adding, setAdding] = useState<HarnessTaskCheckKind>(kinds[0] ?? "output-contains")
  const profiles = useApprovedProfiles(
    projectId,
    checks.some((c) => c.kind === "acceptance-profile")
  )
  const set = (index: number, next: HarnessTaskCheck) =>
    onChange(checks.map((c, i) => (i === index ? next : c)))
  const remove = (index: number) => onChange(checks.filter((_, i) => i !== index))
  const addKind = kinds.includes(adding) ? adding : (kinds[0] ?? "output-contains")

  return (
    <div className="flex flex-col gap-2" data-testid="harness-checks-editor">
      {checks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("checks.none")}</p>
      ) : null}
      {checks.map((check, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
          <span className="text-xs font-medium">{t(`checkKind.${check.kind}`)}</span>
          {check.kind === "deliverable-file" ? (
            <Input
              className="h-8 flex-1"
              value={check.path}
              placeholder={t("checks.pathPlaceholder")}
              aria-label={t("checks.path")}
              onChange={(e) => set(index, { ...check, path: e.target.value })}
            />
          ) : null}
          {check.kind === "output-contains" || check.kind === "output-not-contains" ? (
            <>
              <Input
                className="h-8 flex-1"
                value={check.value}
                aria-label={t("checks.text")}
                placeholder={t("checks.textPlaceholder")}
                onChange={(e) => set(index, { ...check, value: e.target.value })}
              />
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={check.caseSensitive === true}
                  onCheckedChange={(v) => set(index, { ...check, caseSensitive: v === true })}
                />
                {t("checks.caseSensitive")}
              </label>
            </>
          ) : null}
          {check.kind === "output-json" ? (
            <Input
              className="h-8 flex-1"
              value={(check.requiredKeys ?? []).join(", ")}
              aria-label={t("checks.requiredKeys")}
              placeholder={t("checks.requiredKeysPlaceholder")}
              onChange={(e) => {
                const keys = e.target.value
                  .split(",")
                  .map((k) => k.trim())
                  .filter(Boolean)
                set(
                  index,
                  keys.length
                    ? { kind: "output-json", requiredKeys: keys }
                    : { kind: "output-json" }
                )
              }}
            />
          ) : null}
          {check.kind === "max-tool-errors" ? (
            <Input
              className="h-8 w-24"
              type="number"
              min={0}
              value={check.max}
              aria-label={t("checks.max")}
              onChange={(e) =>
                set(index, { ...check, max: Math.max(0, Math.round(Number(e.target.value) || 0)) })
              }
            />
          ) : null}
          {check.kind === "acceptance-profile" ? (
            profiles.length ? (
              <NativeSelect
                size="sm"
                value={check.profileId}
                aria-label={t("checks.profile")}
                onChange={(e) => set(index, { ...check, profileId: e.target.value })}
              >
                <NativeSelectOption value="">{t("checks.pickProfile")}</NativeSelectOption>
                {profiles.map((id) => (
                  <NativeSelectOption key={id} value={id}>
                    {id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : (
              <span className="text-xs text-muted-foreground">{t("checks.noProfiles")}</span>
            )
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-7"
            onClick={() => remove(index)}
            aria-label={t("checks.remove")}
          >
            <Trash2Icon className="size-3.5" aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <NativeSelect
          size="sm"
          value={addKind}
          aria-label={t("checks.kind")}
          onChange={(e) => setAdding(e.target.value as HarnessTaskCheckKind)}
        >
          {kinds.map((kind) => (
            <NativeSelectOption key={kind} value={kind}>
              {t(`checkKind.${kind}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange([...checks, blank(addKind)])}
          data-testid="harness-add-check"
        >
          <PlusIcon className="size-3.5" aria-hidden />
          {t("checks.add")}
        </Button>
      </div>
    </div>
  )
}
