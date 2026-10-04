"use client"

// Opt a `pi-rpc` agent into plugin-shipped Pi packages (ADR-0210).
//
// The selection is stored as `metadata.piPackages` (`<pluginId>/<packageId>`
// references) and loaded with `-e` into every session of the agent. Only
// packages that declare `hostedSession` are offered. Before the user opts in,
// each row says what it costs: whether the package is prepared (an unprepared
// package fails the session start), which tools it adds, and whether it takes
// over the session's tool surface. A saved reference whose plugin is gone or
// disabled stays visible with a remove action, because the adapter refuses to
// start a session with it rather than silently skipping it.

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, PackageIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  useContributedPiPackages,
  type ContributedPiPackageView,
} from "@/hooks/plugins/use-contributed-pi-packages"
import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import { piPackageErrorKey } from "@/lib/plugin/pi-packages/error-keys"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { isPiPackageReady } from "@/lib/plugin/pi-packages/resolve"

export interface PiPluginPackagesFieldProps {
  /** Selected references, in load order. */
  value: string[]
  onChange: (next: string[]) => void
}

export function PiPluginPackagesField({ value, onChange }: PiPluginPackagesFieldProps) {
  const t = useTranslations("plugins.piPackages")
  const { packages } = useContributedPiPackages()

  const hostable = packages.filter((view) => Boolean(view.entry.def.hostedSession))
  const known = new Set<string>(hostable.map((view) => view.entry.ref))
  const unavailable = value.filter((ref) => !known.has(ref))

  const toggle = (ref: string, checked: boolean) => {
    if (checked) onChange(value.includes(ref) ? value : [...value, ref])
    else onChange(value.filter((entry) => entry !== ref))
  }

  return (
    <div className="space-y-2" data-testid="pi-plugin-packages-field">
      <div>
        <Label className="flex items-center gap-1.5">
          <PackageIcon className="size-3.5" />
          {t("picker.label")}
        </Label>
        <p className="text-muted-foreground text-xs">{t("picker.hint")}</p>
      </div>

      {hostable.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="pi-plugin-packages-empty">
          {t("picker.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {hostable.map((view) => (
            <PiPluginPackageOption
              key={view.entry.ref}
              view={view}
              checked={value.includes(view.entry.ref)}
              onToggle={(checked) => toggle(view.entry.ref, checked)}
            />
          ))}
        </ul>
      )}

      {unavailable.length > 0 && (
        <div className="space-y-1" data-testid="pi-plugin-packages-unavailable">
          <p className="text-xs font-medium">{t("picker.unavailableTitle")}</p>
          {unavailable.map((ref) => (
            <div key={ref} className="flex items-center justify-between gap-2">
              <p className="text-destructive text-xs">{t("picker.unavailable", { ref })}</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => onChange(value.filter((entry) => entry !== ref))}
              >
                {t("picker.remove")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PiPluginPackageOption({
  view,
  checked,
  onToggle,
}: {
  view: ContributedPiPackageView
  checked: boolean
  onToggle: (checked: boolean) => void
}) {
  const t = useTranslations("plugins.piPackages")
  const tAll = useTranslations()
  const pluginName = usePluginDisplayName(view.entry.pluginId)
  const { entry, resolved, error } = view
  const id = `pi-plugin-package-${entry.ref.replace(/[^a-z0-9-]/gi, "-")}`
  const name = resolvePluginLabel(tAll, entry.pluginId, entry.def.nameKey, entry.def.name)
  const notReady = Boolean(error) || (resolved !== null && !isPiPackageReady(resolved.prepareState))
  const tools = entry.def.hostedSession?.tools ?? []
  return (
    <li className="flex items-start gap-2" data-testid={id}>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onToggle(next === true)}
        aria-describedby={`${id}-details`}
      />
      <div className="min-w-0 space-y-0.5" id={`${id}-details`}>
        <label htmlFor={id} className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-medium">{name}</span>
          <Badge variant="outline" className="text-[10px]">
            {t("fromPlugin", { plugin: pluginName })}
          </Badge>
        </label>
        {tools.length > 0 && (
          <p className="text-muted-foreground font-mono text-[11px]">
            {t("hosted.tools", { tools: tools.join(", ") })}
          </p>
        )}
        {entry.def.hostedSession?.controlsSession && (
          <p
            className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400"
            data-testid={`${id}-controls-session`}
          >
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            {t("hosted.controlsSession")}
          </p>
        )}
        {notReady && (
          <p className="text-destructive text-xs" data-testid={`${id}-not-ready`}>
            {error
              ? t(`errors.${piPackageErrorKey(error.code, "resolutionFailed")}`)
              : t("picker.notPrepared")}
          </p>
        )}
      </div>
    </li>
  )
}
