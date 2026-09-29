"use client"

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { ProjectEnvironmentSetupReuse } from "@/types/project-environment"

const EMPTY_REUSE: ProjectEnvironmentSetupReuse = { enabled: false, inputs: [], outputs: [] }

/** One path per line. Blank lines are kept while editing so Enter works; `finalizeSetupReuse` drops them. */
function toLines(paths: readonly string[]): string {
  return paths.join("\n")
}

function fromLines(text: string): string[] {
  return text.split("\n")
}

/**
 * The declaration as it should be saved: trimmed, blank lines dropped. Absent
 * when the user never touched reuse, so an environment that did not opt in
 * saves exactly as before. Path validity is enforced by the save boundary
 * (`assertSetupReuse`), whose message the panel already surfaces.
 */
export function finalizeSetupReuse(
  reuse: ProjectEnvironmentSetupReuse | undefined
): ProjectEnvironmentSetupReuse | undefined {
  if (!reuse) return undefined
  const clean = (paths: readonly string[]) =>
    paths.map((path) => path.trim()).filter((path) => path.length > 0)
  const inputs = clean(reuse.inputs)
  const outputs = clean(reuse.outputs)
  if (!reuse.enabled && inputs.length === 0 && outputs.length === 0) return undefined
  return { enabled: reuse.enabled, inputs, outputs }
}

export function ProjectEnvironmentSetupReuseFields({
  value,
  onChange,
  ids,
}: {
  value: ProjectEnvironmentSetupReuse | undefined
  onChange(value: ProjectEnvironmentSetupReuse): void
  ids: string
}) {
  const t = useTranslations("projectEnvironment")
  const reuse = value ?? EMPTY_REUSE
  return (
    <div className="space-y-1.5" data-testid="project-environment-setup-reuse">
      <Label className="flex items-center gap-2 text-xs">
        <Switch
          checked={reuse.enabled}
          onCheckedChange={(enabled) => onChange({ ...reuse, enabled })}
          aria-label={t("setupReuse")}
        />
        {t("setupReuse")}
      </Label>
      <p className="text-[10px] text-muted-foreground">{t("setupReuseDescription")}</p>
      {reuse.enabled && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${ids}-inputs`} className="text-[11px]">
              {t("setupReuseInputs")}
            </Label>
            <Textarea
              id={`${ids}-inputs`}
              value={toLines(reuse.inputs)}
              onChange={(event) => onChange({ ...reuse, inputs: fromLines(event.target.value) })}
              placeholder={t("setupReuseInputsPlaceholder")}
              className="min-h-16 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-outputs`} className="text-[11px]">
              {t("setupReuseOutputs")}
            </Label>
            <Textarea
              id={`${ids}-outputs`}
              value={toLines(reuse.outputs)}
              onChange={(event) => onChange({ ...reuse, outputs: fromLines(event.target.value) })}
              placeholder={t("setupReuseOutputsPlaceholder")}
              className="min-h-16 font-mono text-xs"
            />
          </div>
          <p className="text-[10px] text-muted-foreground sm:col-span-2">
            {t("setupReuseManualNote")}
          </p>
        </div>
      )}
    </div>
  )
}
