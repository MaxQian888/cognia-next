"use client"

/**
 * What to know about a preset before adding it: its support tier, whether the
 * Host already has the runtime installed, where its docs are, and what it
 * needs set up (an install step, an environment variable, another surface of
 * the same product that might fit better).
 */

import { useTranslations } from "next-intl"
import { ExternalLink } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getExternalAgentEcosystemAdapter } from "@/lib/ai/agent/external/ecosystem-adapters"
import type { ExternalAgentPresetConfig } from "@/lib/ai/agent/external/config/presets"
import type { ProcessPlaneUnavailableReason } from "@/lib/ai/agent/external/capability/process-plane"
import type { InstalledAgentRuntimes } from "@/hooks/agent/use-installed-agent-runtimes"
import { RuntimeDetectionBadge } from "../runtime-detection-badge"
import { presetEnvVarHint, presetSetupHint, supportTierLabel } from "./preset-copy"

/**
 * Reason code to message key. The codes are the plane's vocabulary (kebab, and
 * wire-shaped); the keys are the catalogue's. Kept as a table so tests can
 * assert every code has a translation: `lint:i18n` cannot see through the
 * template literal that resolves them.
 */
export const PLANE_WARNING_KEYS: Record<ProcessPlaneUnavailableReason, string> = {
  "no-host": "noHost",
  "manifest-missing": "manifestMissing",
  unsupported: "unsupported",
  "not-granted": "notGranted",
}

/**
 * The same mapping for the detection line, plus the one state the plane cannot
 * describe: it was reachable, it was asked, and it did not answer. Blaming that
 * on the plane's `unsupported` accused a Host that had declared the operation.
 */
export const DETECTION_UNAVAILABLE_KEYS: Record<ProcessPlaneUnavailableReason | "failed", string> =
  {
    ...PLANE_WARNING_KEYS,
    failed: "failed",
  }

export interface PresetGuidanceProps {
  presetId: string
  preset: ExternalAgentPresetConfig
  detection: InstalledAgentRuntimes
  className?: string
}

export function PresetGuidance({ presetId, preset, detection, className }: PresetGuidanceProps) {
  const tManager = useTranslations("externalAgent.manager")
  const tTier = useTranslations("externalAgent.supportTier")
  const adapter = preset.adapterId ? getExternalAgentEcosystemAdapter(preset.adapterId) : null
  const relatedSurfaces =
    adapter?.surfaces.filter((surface) => surface.id !== preset.surfaceId) ?? []
  const setupHint = presetSetupHint(tManager, presetId, preset)
  const envVarHint = presetEnvVarHint(tManager, presetId, preset)

  return (
    <div className={cn("grid gap-3", className)} data-testid="preset-guidance">
      <div className="space-y-2 rounded-md border p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          {preset.supportTier && (
            <Badge variant="outline" className="text-[10px]">
              {supportTierLabel(tTier, preset.supportTier)}
            </Badge>
          )}
          <RuntimeDetectionBadge detection={detection.forPreset(presetId)} showVersion />
          {detection.loading && (
            <span className="text-[10px] text-muted-foreground">
              {tManager("detectionRunning")}
            </span>
          )}
          {/* An absent badge means "not asked", which reads as silence. Saying
              why, and offering the re-ask, is the difference between a missing
              answer and an unexplained blank. */}
          {!detection.loading && detection.unavailable && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              {tManager(
                `detectionUnavailable.${DETECTION_UNAVAILABLE_KEYS[detection.unavailable]}`
              )}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={detection.refresh}
              >
                {tManager("detectionRetry")}
              </button>
            </span>
          )}
          {preset.docsUrl && (
            <a
              href={preset.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {tManager("officialDocs")}
            </a>
          )}
        </div>
        {setupHint && <p>{setupHint}</p>}
        {relatedSurfaces.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">{tManager("otherOfficialSurfaces")}</p>
            {relatedSurfaces.map((surface) => (
              <div key={surface.id} className="rounded-sm border bg-muted/40 px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span>{surface.name}</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {supportTierLabel(tTier, surface.supportTier)}
                  </Badge>
                </div>
                <p className="mt-1 text-muted-foreground">
                  {surface.limitationNote ?? surface.setupHint ?? surface.description}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {envVarHint && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span className="font-medium">{tManager("noteLabel")}:</span> {envVarHint}
        </div>
      )}
    </div>
  )
}
